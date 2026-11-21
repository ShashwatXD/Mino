import { GUARD } from "../config/guardrails.ts";
import type { Repositories } from "../db/repositories/index.ts";
import type { Completion } from "../llm/small/completer.ts";
import type { Titler } from "../llm/small/title.ts";

const TITLE_CHARS = 60;

export const cleanTitle = (text: string) =>
  (text.trim().split("\n")[0] ?? "")
    .replace(/^title\s*:\s*/i, "")
    .replace(/^[\s"'“”*#]+|[\s"'“”*.]+$/g, "")
    .slice(0, TITLE_CHARS)
    .trim();

/** Runs beside the first reply, so the chat is named by the time the answer ends. A failure leaves the opening question as its name. */
export async function nameChat(store: Repositories, title: Titler, threadId: string, message: string): Promise<Completion> {
  const completion = await title(message.slice(0, 2000), AbortSignal.timeout(GUARD.titleTimeoutMs));
  const name = cleanTitle(completion.text);
  if (name) store.threads.saveTitle(threadId, name);
  return completion;
}
