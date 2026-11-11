import type { Repositories } from "../db/repositories/index.ts";
import type { Turn } from "../domain/turn.ts";
import { MAX_SEARCHES } from "../llm/prompt.ts";
import { recall, type Recall } from "../memory/recall.ts";
import { renderContext } from "../memory/render.ts";

const RECHECK_SEARCHES = 8;
const RECENT_CHATS = 15;
const RECHECK = /still (correct|true|valid|accurate|right)|\b(has|have|did)\b.*\b(chang|updat|ship)|changed since|any (price|pricing) change/i;

interface BuildOptions {
  store: Repositories;
  text: string;
  now: number;
  tz: string;
  threadId: string;
  history: Turn[];
  excludeIds: Set<number>;
}

interface BuiltContext {
  found: Recall;
  context: string;
  maxSearches: number;
}

/** What the model knows before it starts. It can look further with its history tool. */
export function buildContext(options: BuildOptions): BuiltContext {
  const { store, text, now, tz, threadId, history, excludeIds } = options;
  const found = recall(store.turns, text, now, tz, excludeIds);

  const recheck = RECHECK.test(text) && found.turns.length > 0 && found.kind !== "related";
  const notes: string[] = [];
  if (recheck) {
    notes.push(`The user wants earlier information re-checked. Take each item from the log and run a separate web_search for it, up to ${RECHECK_SEARCHES}. Unless a source shows the value on both dates, say "no evidence of change", not "no change".`);
  }

  // Older turns of a long chat fall out of the replayed history, so their summary stands in.
  const chatSummary = store.turns.count(threadId) > history.length ? store.summaries.get(threadId)?.text ?? null : null;
  const layers = { recentChats: store.threads.recent(RECENT_CHATS, threadId), chatSummary };
  const context = [renderContext(found, now, tz, store.facts.list(), layers), ...notes].join("\n");
  return { found, context, maxSearches: recheck ? RECHECK_SEARCHES : MAX_SEARCHES };
}
