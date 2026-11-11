import { randomUUID } from "node:crypto";
import type { ChatRequest } from "../config/config.ts";
import { buildContext } from "../context/build.ts";
import { updateChatSummary } from "../context/summary.ts";
import { nameChat } from "../context/title.ts";
import type { Repositories } from "../db/repositories/index.ts";
import type { Source, Turn, TurnStatus } from "../domain/turn.ts";
import type { Helpers } from "../llm/small/index.ts";
import type { AgentEvent, TurnOptions, TurnResult } from "../llm/types.ts";
import { extractFacts } from "../memory/facts.ts";
import { fitHistory } from "../memory/history.ts";
import { searchHistory } from "../memory/search.ts";
import type { Run, RunRegistry } from "../streaming/runs.ts";
import { safeTimeZone } from "../text/time.ts";
import { friendlyError, NoEngineError } from "./errors.ts";
import { estimateTokens, type SpendGuard } from "./spend-guard.ts";
import type { TemporaryChats } from "./temporary-chats.ts";
import { TraceRecorder } from "./tracer.ts";

const HISTORY_TURNS = 20;
const DRAFT_DEBOUNCE_MS = 400;
const RUN_TIMEOUT_MS = 180_000;

export interface ChatDeps {
  store: Repositories;
  run: (options: TurnOptions) => Promise<TurnResult>;
  guard?: SpendGuard;
  helpers?: () => Helpers;
  currentModel?: () => string;
  now?: () => number;
  runTimeoutMs?: number;
  draftMs?: number;
}

export type StartResult = { run: Run } | { status: 409 | 429; message: string };

/** Where a reply is kept: the database for a normal chat, process memory for a temporary one. */
interface TurnRecord {
  draft(text: string): void;
  finish(result: { assistantText: string; sources: Source[]; queries: string[]; status: TurnStatus }): void;
}

/** Admits a message, records it, and starts its reply in the background. */
export function startChat(deps: ChatDeps, runs: RunRegistry, temporaryChats: TemporaryChats, request: ChatRequest): StartResult {
  const threadId = request.threadId ?? randomUUID();
  const run = runs.start(threadId);
  if (!run) return { status: 409, message: "A reply is already in progress in this chat." };
  const refused = deps.guard?.admit(runs.count - 1);
  if (refused) {
    runs.finish(run);
    return { status: 429, message: refused };
  }

  const userText = request.message;
  const tz = safeTimeZone(request.timezone);
  const now = (deps.now ?? Date.now)();
  const temporary = request.incognito === true;
  const settled = (t: Turn) => t.status === "ok" || t.status === "interrupted";

  if (temporary) {
    const history = fitHistory(temporaryChats.turns(threadId, now).filter(settled));
    const record: TurnRecord = {
      draft: () => {},
      finish: (result) => {
        if (result.status !== "failed") temporaryChats.add(threadId, { createdAt: now, userText, ...result });
      },
    };
    reply(deps, runs, run, record, { history, userText, tz, now, temporary, thinkMore: request.thinkMore === true });
    return { run };
  }

  for (const fact of extractFacts(userText)) deps.store.facts.save(fact.key, fact.value, now);
  const history = fitHistory(deps.store.turns.ofThread(threadId, HISTORY_TURNS).filter(settled));
  const turnId = deps.store.turns.begin(threadId, now, userText);
  const record: TurnRecord = {
    draft: (text) => deps.store.turns.updateDraft(turnId, text),
    finish: (result) => deps.store.turns.finish(turnId, result),
  };
  reply(deps, runs, run, record, { history, userText, tz, now, temporary, thinkMore: request.thinkMore === true });
  return { run };
}

function reply(deps: ChatDeps, runs: RunRegistry, run: Run, record: TurnRecord, input: { history: Turn[]; userText: string; tz: string; now: number; temporary: boolean; thinkMore: boolean }): void {
  const { history, userText, tz, now, temporary, thinkMore } = input;
  // A temporary chat leaves no trace, like it leaves no turn.
  const trace = temporary ? null : new TraceRecorder(run.threadId, userText, now);
  let text = "";
  let context = "";
  let timer: NodeJS.Timeout | null = null;
  let searches = 0;
  let timedOut = false;
  // A hung provider must not hold a reply, or its cost, open forever.
  const deadline = setTimeout(() => {
    timedOut = true;
    run.abort.abort();
  }, deps.runTimeoutMs ?? RUN_TIMEOUT_MS);
  deadline.unref();

  // Tokens stay in memory and reach disk on a debounce, so storage never slows the stream.
  const flushLater = () => {
    timer ??= setTimeout(() => {
      timer = null;
      record.draft(text);
    }, deps.draftMs ?? DRAFT_DEBOUNCE_MS);
  };
  const clearDraftTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const emit = (event: AgentEvent) => {
    if (event.type === "text") {
      text += event.text;
      trace?.firstText();
      flushLater();
    }
    if (event.type === "search") {
      searches++;
      trace?.webSearch(event.query);
    }
    run.emit(event);
  };

  (async () => {
    const helpers = deps.helpers?.();
    const naming =
      helpers?.title && !temporary && history.length === 0 && !deps.guard?.overBudget()
        ? (trace ? trace.stepAsync("title", () => nameChat(deps.store, helpers.title!, run.threadId, userText)) : nameChat(deps.store, helpers.title, run.threadId, userText))
            .then((used) => {
              deps.guard?.record(used);
              trace?.smallModel(used);
            })
            .catch(() => {})
        : null;
    try {
      const build = () => buildContext({ store: deps.store, text: userText, temporary, now, tz, threadId: run.threadId, history });
      const built = trace ? trace.step("build_prompt", build, (b) => ({ chars: b.context.length, historyTurns: history.length })) : build();
      context = built.context;
      run.abort.signal.throwIfAborted();

      const model = deps.currentModel?.() ?? "unknown";
      const answer = () => deps.run({
        history,
        userText,
        context,
        tz,
        emit,
        signal: run.abort.signal,
        maxSearches: built.maxSearches,
        effort: thinkMore ? "high" : undefined,
        // A temporary chat gets no history tool, so nothing from the user's past reaches it.
        searchHistory: temporary
          ? undefined
          : (query) => {
              const started = performance.now();
              const found = searchHistory(deps.store.turns, query, tz);
              trace?.history(query, found, Math.round(performance.now() - started));
              return found;
            },
      });
      const result = trace
        ? await trace.stepAsync("model", answer, (r) => ({ model, effort: thinkMore ? "high" : "default", inputTokens: r.usage?.inputTokens ?? 0, outputTokens: r.usage?.outputTokens ?? 0, stopReason: r.stopReason ?? "" }))
        : await answer();
      clearDraftTimer();
      record.finish({ assistantText: result.text, sources: result.sources, queries: result.queries, status: "ok" });
      if (result.usage) deps.guard?.record(result.usage);
      // The title call started with the reply and is capped at a few seconds, so the sidebar can show it on "done".
      await naming;
      if (trace) deps.store.traces.save(trace.finish("ok", model, result.usage));
      run.emit({ type: "done", threadId: run.threadId });
      if (helpers?.summarize && !temporary && !deps.guard?.overBudget()) {
        updateChatSummary(deps.store, helpers.summarize, run.threadId)
          .then((used) => used && deps.guard?.record(used))
          .catch(() => {});
      }
    } catch (err) {
      clearDraftTimer();
      const stopped = run.abort.signal.aborted;
      // What already arrived is kept, and the question stays on record either way.
      record.finish({ assistantText: text, sources: [], queries: [], status: stopped ? "interrupted" : "failed" });
      // A reply cut short never reports usage, so what it visibly consumed is estimated.
      if (text) {
        const prompt = history.reduce((n, t) => n + t.userText.length + t.assistantText.length, context.length + userText.length);
        deps.guard?.record({ model: deps.currentModel?.() ?? "unknown", inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(text.length), searches });
      }
      if (trace) deps.store.traces.save(trace.finish(timedOut ? "timed_out" : stopped ? "interrupted" : "failed", deps.currentModel?.() ?? "unknown"));
      if (timedOut) run.emit({ type: "error", text: "This reply took too long and was stopped." });
      else if (stopped) run.emit({ type: "stopped" });
      else {
        if (!(err instanceof NoEngineError)) console.error(err);
        run.emit({ type: "error", text: friendlyError(err) });
      }
    } finally {
      clearTimeout(deadline);
      runs.finish(run);
    }
  })();
}
