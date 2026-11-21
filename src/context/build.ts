import type { Repositories } from "../db/repositories/index.ts";
import type { Turn } from "../domain/turn.ts";
import { GUARD } from "../config/guardrails.ts";
import { renderContext } from "../memory/render.ts";

// Re-checking a list of items needs a search per item, so those replies get a higher cap.
const RECHECK = /still (correct|true|valid|accurate|right)|\b(has|have|did)\b.*\b(chang|updat|ship)|changed since|any (price|pricing) change/i;

interface BuildOptions {
  store: Repositories;
  now: number;
  tz: string;
  threadId: string;
  history: Turn[];
  text: string;
  /** A temporary chat neither uses nor shows the user's memory. */
  temporary?: boolean;
}

interface BuiltContext {
  context: string;
  maxSearches: number;
}

/** The always-on layers. Exact past turns come only from the model's search_history calls. */
export function buildContext(options: BuildOptions): BuiltContext {
  const { store, now, tz, threadId, history, text, temporary } = options;
  const maxSearches = RECHECK.test(text) ? GUARD.maxWebSearchesRecheck : GUARD.maxWebSearches;
  if (temporary) return { context: renderContext(now, tz), maxSearches };
  // Older turns of a long chat fall out of the replayed history, so their summary stands in.
  const chatSummary = store.turns.count(threadId) > history.length ? store.summaries.get(threadId)?.text ?? null : null;
  const layers = { recentChats: store.threads.recent(GUARD.recentChats, threadId), chatSummary };
  return { context: renderContext(now, tz, store.facts.list(), layers), maxSearches };
}
