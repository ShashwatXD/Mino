import { z } from "zod";
import type { HistoryQuery } from "../domain/turn.ts";
import type { TurnOptions } from "./types.ts";

/** Rounds of history lookups allowed in one reply, so a confused model cannot loop forever. */
export const MAX_HISTORY_CALLS = 4;

export const HISTORY_TOOL = {
  name: "search_history",
  description:
    "Search the user's past conversations with you. Past turns are not in your context, so call this whenever the user refers to something said before, names a past date, or asks whether an earlier answer still holds. " +
    "Filters combine: from/to for a date range (YYYY-MM-DD in the user's time zone, same date twice for one day), query for topic words matched despite typos, pattern for exact text or a regex like grep, and chat_id to read one whole chat. " +
    "Each result has its chat id, timestamp and sources. If nothing matches on the date asked, it says so and shows strong matches from other dates. Search again with a wider range or other words if the first result misses.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Topic words, such as product or place names" },
      pattern: { type: "string", description: "Exact text or a case-insensitive regex to find in questions and answers" },
      from: { type: "string", description: "First day to include, YYYY-MM-DD" },
      to: { type: "string", description: "Last day to include, YYYY-MM-DD" },
      chat_id: { type: "string", description: "Read every turn of this chat, from a chat id in an earlier result" },
    },
  },
} as const;

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Args = z.object({
  query: z.string().max(300).nullish(),
  pattern: z.string().max(200).nullish(),
  from: DATE.nullish(),
  to: DATE.nullish(),
  chat_id: z.string().max(100).nullish(),
});

/** Runs one history lookup for any engine. A bad call becomes a message the model can correct. */
export function runHistoryTool(options: TurnOptions, raw: unknown, round: number): string {
  if (!options.searchHistory) return "History search is not available.";
  if (round >= MAX_HISTORY_CALLS) return "The history search limit for this reply is reached. Answer with what you already have.";
  const args = Args.safeParse(typeof raw === "string" ? safeJson(raw) : raw);
  if (!args.success) return "The arguments were not valid. Use query, pattern, from and to (YYYY-MM-DD), or chat_id.";
  const { query, pattern, from, to, chat_id } = args.data;
  const request: HistoryQuery = { query: query ?? undefined, pattern: pattern ?? undefined, from: from ?? undefined, to: to ?? undefined, chatId: chat_id ?? undefined };
  options.emit({ type: "status", text: "Checking past chats" });
  return options.searchHistory(request);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return null;
  }
}
