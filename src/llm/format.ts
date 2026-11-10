import type { Source, Turn } from "../domain/turn.ts";
import { formatStamp } from "../text/time.ts";

/** Past turns as text pairs, each question stamped with when it was asked. */
export function pastPairs(history: Turn[], tz: string): { user: string; assistant: string }[] {
  return history
    .filter((turn) => turn.assistantText)
    .map((turn) => ({
      user: `[${formatStamp(tz, turn.createdAt)}] ${turn.userText}`,
      assistant: turn.assistantText,
    }));
}

export function citedFirst(sources: Map<string, Source>): Source[] {
  return [...sources.values()].sort((a, b) => Number(b.cited) - Number(a.cited));
}
