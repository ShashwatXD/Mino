import { z } from "zod";
import type { HistoryQuery } from "../domain/turn.ts";
import type { TurnOptions } from "./types.ts";

/** Rounds of history lookups allowed in one reply, so a confused model cannot loop forever. */
export const MAX_HISTORY_CALLS = 4;

export const HISTORY_TOOL = {
  name: "search_history",
  description:
    "Search the user's past conversations with you. Use it whenever the user refers to something said before, names a past date, or asks whether an earlier answer still holds. " +
    "Give a date range for date questions (YYYY-MM-DD in the user's time zone; use the same date twice for one day), a topic for topic questions, or both. " +
    "Returns the exact past turns with timestamps and sources, or states that nothing was found. If the result does not answer the question, search again with a wider range or other words.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Topic words to match, such as product or place names" },
      from: { type: "string", description: "First day to include, YYYY-MM-DD" },
      to: { type: "string", description: "Last day to include, YYYY-MM-DD" },
    },
  },
} as const;

const Args = z.object({
  query: z.string().max(300).nullish(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});

/** Runs one history lookup for any engine. A bad call becomes a message the model can correct. */
export function runHistoryTool(options: TurnOptions, raw: unknown, round: number): string {
  if (!options.searchHistory) return "History search is not available.";
  if (round >= MAX_HISTORY_CALLS) return "The history search limit for this reply is reached. Answer with what you already have.";
  const args = Args.safeParse(typeof raw === "string" ? safeJson(raw) : raw);
  if (!args.success) return "The arguments were not valid. Use query, from and to (YYYY-MM-DD).";
  const query: HistoryQuery = { query: args.data.query ?? undefined, from: args.data.from ?? undefined, to: args.data.to ?? undefined };
  options.emit({ type: "status", text: "Checking past chats" });
  return options.searchHistory(query);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return null;
  }
}
