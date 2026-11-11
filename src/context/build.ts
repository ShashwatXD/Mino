import type { Repositories } from "../db/repositories/index.ts";
import type { Turn } from "../domain/turn.ts";
import { MAX_SEARCHES } from "../llm/prompt.ts";
import { renderContext } from "../memory/render.ts";

const RECHECK_SEARCHES = 8;
const RECENT_CHATS = 15;
const RECHECK = /still (correct|true|valid|accurate|right)|\b(has|have|did)\b.*\b(chang|updat|ship)|changed since|any (price|pricing) change/i;

interface BuildOptions {
  store: Repositories;
  now: number;
  tz: string;
  threadId: string;
  history: Turn[];
  text: string;
}

interface BuiltContext {
  context: string;
  maxSearches: number;
}

/** The always-on layers. Exact past turns come only from the model's search_history calls. */
export function buildContext(options: BuildOptions): BuiltContext {
  const { store, now, tz, threadId, history, text } = options;
  // Older turns of a long chat fall out of the replayed history, so their summary stands in.
  const chatSummary = store.turns.count(threadId) > history.length ? store.summaries.get(threadId)?.text ?? null : null;
  const layers = { recentChats: store.threads.recent(RECENT_CHATS, threadId), chatSummary };
  // Re-checking a list of items needs a search per item, so those replies get a higher cap.
  return { context: renderContext(now, tz, store.facts.list(), layers), maxSearches: RECHECK.test(text) ? RECHECK_SEARCHES : MAX_SEARCHES };
}
