import { GUARD } from "../config/guardrails.ts";
import type { Repositories } from "../db/repositories/index.ts";
import type { Completion } from "../llm/small/completer.ts";
import type { Summarizer } from "../llm/small/summarize.ts";


const summarizing = new Set<string>();

/** Runs after a reply ends, so it can never slow an answer. A failure is retried on the next reply. */
export async function updateChatSummary(store: Repositories, summarize: Summarizer, threadId: string): Promise<Completion | null> {
  if (summarizing.has(threadId)) return null;
  summarizing.add(threadId);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), GUARD.summaryTimeoutMs);
  try {
    const existing = store.summaries.get(threadId);
    const turns = store.turns.after(threadId, existing?.coveredTurnId ?? 0, GUARD.summaryTurns);
    if (turns.length === 0) return null;
    const completion = await summarize(
      {
        previous: existing?.text ?? null,
        turns: turns.map((t) => ({ user: t.userText, assistant: t.assistantText.slice(0, GUARD.summarizedAnswerChars) })),
      },
      timeout.signal,
    );
    const text = completion.text.trim();
    if (text) store.summaries.save(threadId, text, turns.at(-1)!.id, turns.at(-1)!.createdAt);
    return completion;
  } finally {
    clearTimeout(timer);
    summarizing.delete(threadId);
  }
}
