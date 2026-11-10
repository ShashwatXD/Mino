import { randomUUID } from "node:crypto";
import type { ChatRequest } from "../config/config.ts";
import { buildContext, type Helpers } from "../context/build.ts";
import { updateChatSummary } from "../context/summary.ts";
import { nameChat } from "../context/title.ts";
import type { Repositories } from "../db/repositories/index.ts";
import type { Turn } from "../domain/turn.ts";
import type { AgentEvent, TurnOptions, TurnResult } from "../llm/types.ts";
import { extractFacts } from "../memory/facts.ts";
import { fitHistory } from "../memory/history.ts";
import type { Run, RunRegistry } from "../streaming/runs.ts";
import { safeTimeZone } from "../text/time.ts";
import { friendlyError, NoEngineError } from "./errors.ts";
import { estimateTokens, type SpendGuard } from "./spend-guard.ts";

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

/** Admits a message, records it, and starts its reply in the background. */
export function startChat(deps: ChatDeps, runs: RunRegistry, request: ChatRequest): StartResult {
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
  for (const fact of extractFacts(userText)) deps.store.facts.save(fact.key, fact.value, now);
  const history = fitHistory(deps.store.turns.ofThread(threadId, HISTORY_TURNS).filter((t) => t.status === "ok" || t.status === "interrupted"));
  const turnId = deps.store.turns.begin(threadId, now, userText);
  reply(deps, runs, run, turnId, { history, userText, tz, now });
  return { run };
}

function reply(deps: ChatDeps, runs: RunRegistry, run: Run, turnId: number, input: { history: Turn[]; userText: string; tz: string; now: number }): void {
  const { history, userText, tz, now } = input;
  const turns = deps.store.turns;
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
      turns.updateDraft(turnId, text);
    }, deps.draftMs ?? DRAFT_DEBOUNCE_MS);
  };
  const clearDraftTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const emit = (event: AgentEvent) => {
    if (event.type === "text") {
      text += event.text;
      flushLater();
    }
    if (event.type === "search") searches++;
    run.emit(event);
  };

  (async () => {
    const helpers = deps.helpers?.();
    const naming =
      helpers?.title && history.length === 0 && !deps.guard?.overBudget()
        ? nameChat(deps.store, helpers.title, run.threadId, userText)
            .then((used) => deps.guard?.record(used))
            .catch(() => {})
        : null;
    try {
      const built = await buildContext({
        store: deps.store,
        text: userText,
        now,
        tz,
        threadId: run.threadId,
        history,
        excludeIds: new Set([...history.map((t) => t.id), turnId]),
        helpers,
      });
      context = built.context;
      for (const usage of built.usage) deps.guard?.record(usage);
      run.abort.signal.throwIfAborted();

      const result = await deps.run({ history, userText, context, tz, emit, signal: run.abort.signal, maxSearches: built.maxSearches });
      clearDraftTimer();
      turns.finish(turnId, { assistantText: result.text, sources: result.sources, queries: result.queries, status: "ok" });
      if (result.usage) deps.guard?.record(result.usage);
      // The title call started with the reply and is capped at a few seconds, so the sidebar can show it on "done".
      await naming;
      run.emit({ type: "done", threadId: run.threadId });
      if (helpers?.summarize && !deps.guard?.overBudget()) {
        updateChatSummary(deps.store, helpers.summarize, run.threadId)
          .then((used) => used && deps.guard?.record(used))
          .catch(() => {});
      }
    } catch (err) {
      clearDraftTimer();
      const stopped = run.abort.signal.aborted;
      // What already arrived is kept, and the question stays on record either way.
      turns.finish(turnId, { assistantText: text, sources: [], queries: [], status: stopped ? "interrupted" : "failed" });
      // A reply cut short never reports usage, so what it visibly consumed is estimated.
      if (text) {
        const prompt = history.reduce((n, t) => n + t.userText.length + t.assistantText.length, context.length + userText.length);
        deps.guard?.record({ model: deps.currentModel?.() ?? "unknown", inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(text.length), searches });
      }
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
