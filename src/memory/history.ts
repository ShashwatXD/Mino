import type { Turn } from "../domain/turn.ts";

const HISTORY_BUDGET_CHARS = 30_000;

/** Keeps the newest turns that fit. Older ones are not lost, because search can still reach them. */
export function fitHistory(turns: Turn[], budget = HISTORY_BUDGET_CHARS): Turn[] {
  const kept: Turn[] = [];
  let used = 0;
  for (const turn of [...turns].reverse()) {
    const size = turn.userText.length + turn.assistantText.length;
    if (used + size > budget) {
      if (kept.length === 0) kept.push({ ...turn, assistantText: turn.assistantText.slice(0, Math.max(0, budget - turn.userText.length)) });
      break;
    }
    kept.push(turn);
    used += size;
  }
  return kept.reverse();
}
