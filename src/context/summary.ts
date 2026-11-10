import type { Repositories } from "../db/repositories/index.ts";
import type { Summarizer } from "../llm/small/summarize.ts";
import type { Usage } from "../llm/types.ts";

const SUMMARY_TIMEOUT_MS = 15_000;
const TURNS_PER_SUMMARY = 6;
const SUMMARIZED_ANSWER_CHARS = 2000;

const summarizing = new Set<string>();

/** Runs after a reply ends, so it can never slow an answer. A failure is retried on the next reply. */
export async function updateChatSummary(store: Repositories, summarize: Summarizer, threadId: string): Promise<Usage | null> {
  if (summarizing.has(threadId)) return null;
  summarizing.add(threadId);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), SUMMARY_TIMEOUT_MS);
  try {
    const existing = store.summaries.get(threadId);
    const turns = store.turns.after(threadId, existing?.coveredTurnId ?? 0, TURNS_PER_SUMMARY);
    if (turns.length === 0) return null;
    const { text, usage } = await summarize(
      {
        previous: existing?.text ?? null,
        turns: turns.map((t) => ({ user: t.userText, assistant: t.assistantText.slice(0, SUMMARIZED_ANSWER_CHARS) })),
      },
      timeout.signal,
    );
    if (text.trim()) store.summaries.save(threadId, text.trim(), turns.at(-1)!.id, turns.at(-1)!.createdAt);
    return usage;
  } finally {
    clearTimeout(timer);
    summarizing.delete(threadId);
  }
}
