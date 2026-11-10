import { z } from "zod";
import { MAX_SEARCHES, pastPairs, type Usage } from "./engines/shared.ts";
import type { Summarizer, Understander } from "./engines/small.ts";
import { recall, renderContext, type Hint, type Recall } from "./memory.ts";
import type { Store, Turn } from "./store.ts";
import { formatStamp } from "./time.ts";

const STEP_TIMEOUT_MS = 1500;
const RECHECK_SEARCHES = 8;
const RECENT_CHATS = 15;
const SUMMARY_TIMEOUT_MS = 15_000;
const TURNS_PER_SUMMARY = 6;
const SUMMARIZED_ANSWER_CHARS = 2000;
const RECENT_FOR_UNDERSTANDING = 3;
const SHORTENED_TURN_CHARS = 200;

const HINGLISH =
  /[ऀ-ॿ]|\b(kya|kaise|kyun|kyu|kab|woh|wo|wala|wali|wale|kimat|keemat|batao|bata|hai|hain|tha|thi|mera|mere|mujhe|pehle|wahi|yaar|bhai|kuch|badli|badla)\b/i;
const VAGUE = /\b(that one|the one|that thing|same one|the other one|that (tool|product|idea|list|topic))\b/i;
const RECHECK =
  /still (correct|true|valid|accurate|right)|\b(has|have|did)\b.*\b(chang|updat|ship)|changed since|any (price|pricing) change|\bbadl[aie]\b/i;

const Understanding = z.object({
  intent: z.enum(["chat", "new_question", "recall", "recheck"]),
  needs_web: z.boolean(),
  standalone_query: z.string().max(500),
  time_range: z
    .object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
    .nullable(),
  keywords: z.array(z.string().max(40)).max(12),
});
type Understanding = z.infer<typeof Understanding>;

export interface Helpers {
  understand?: Understander;
  summarize?: Summarizer;
}

/** The local pass decides this, so clear messages never pay for a model call. */
export function needsUnderstanding(text: string, local: Recall): boolean {
  // A date that was understood needs no help, whether or not that day has any chats.
  if (local.requested) return false;
  return HINGLISH.test(text) || VAGUE.test(text) || local.kind === "latest" || local.kind === "no_record";
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STEP_TIMEOUT_MS);
  try {
    return await work(controller.signal);
  } catch {
    // A helper step can never stop the reply. The caller continues without it.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseUnderstanding(text: string): Understanding | null {
  try {
    return Understanding.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

interface BuiltContext {
  found: Recall;
  context: string;
  maxSearches: number;
  usage: Usage[];
}

interface BuildOptions {
  store: Store;
  text: string;
  now: number;
  tz: string;
  threadId: string;
  history: Turn[];
  excludeIds: Set<number>;
  helpers?: Helpers;
}

/** Everything the answering model will know before it starts, assembled without giving it a tool. */
export async function buildContext(options: BuildOptions): Promise<BuiltContext> {
  const { store, text, now, tz, threadId, history, excludeIds, helpers } = options;
  const usage: Usage[] = [];
  let found = recall(store, text, now, tz, excludeIds);
  let understanding: Understanding | null = null;

  if (helpers?.understand && needsUnderstanding(text, found)) {
    const reply = await withTimeout((signal) =>
      helpers.understand!(
        {
          message: text,
          recent: pastPairs(history, tz)
            .slice(-RECENT_FOR_UNDERSTANDING)
            .map((t) => ({ user: t.user.slice(0, SHORTENED_TURN_CHARS), assistant: t.assistant.slice(0, SHORTENED_TURN_CHARS) })),
          now: formatStamp(tz, now),
          tz,
        },
        signal,
      ),
    );
    if (reply) {
      usage.push(reply.usage);
      understanding = parseUnderstanding(reply.text);
    }
  }

  const hint: Hint | undefined = understanding
    ? { intent: understanding.intent, keywords: understanding.keywords, timeRange: understanding.time_range }
    : undefined;
  if (hint) found = recall(store, text, now, tz, excludeIds, { hint });

  const recheck = (understanding?.intent === "recheck" || RECHECK.test(text)) && found.turns.length > 0 && found.kind !== "related";
  const notes: string[] = [];
  if (recheck) {
    notes.push(`The user wants earlier information re-checked. Take each item from the log and run a separate web_search for it, up to ${RECHECK_SEARCHES}. Unless a source shows the value on both dates, say "no evidence of change", not "no change".`);
  }
  if (understanding && !understanding.needs_web && !recheck) notes.push("This message does not need a web search.");
  if (understanding?.standalone_query) notes.push(`The message appears to mean: ${JSON.stringify(understanding.standalone_query)}`);

  // Older turns of a long chat fall out of the replayed history, so their summary stands in.
  const chatSummary = store.turnCount(threadId) > history.length ? store.summary(threadId)?.text ?? null : null;
  const layers = { recentChats: store.recentChats(RECENT_CHATS, threadId), chatSummary };
  const context = [renderContext(found, now, tz, store.facts(), layers), ...notes].join("\n");
  return { found, context, maxSearches: recheck ? RECHECK_SEARCHES : MAX_SEARCHES, usage };
}

const summarizing = new Set<string>();

/** Runs after a reply ends, so it can never slow an answer. A failure is retried on the next reply. */
export async function updateChatSummary(store: Store, summarize: Summarizer, threadId: string): Promise<Usage | null> {
  if (summarizing.has(threadId)) return null;
  summarizing.add(threadId);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), SUMMARY_TIMEOUT_MS);
  try {
    const existing = store.summary(threadId);
    const turns = store.turnsAfter(threadId, existing?.coveredTurnId ?? 0, TURNS_PER_SUMMARY);
    if (turns.length === 0) return null;
    const { text, usage } = await summarize(
      {
        previous: existing?.text ?? null,
        turns: turns.map((t) => ({ user: t.userText, assistant: t.assistantText.slice(0, SUMMARIZED_ANSWER_CHARS) })),
      },
      timeout.signal,
    );
    if (text.trim()) store.saveSummary(threadId, text.trim(), turns.at(-1)!.id, turns.at(-1)!.createdAt);
    return usage;
  } finally {
    clearTimeout(timer);
    summarizing.delete(threadId);
  }
}
