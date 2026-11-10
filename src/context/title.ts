import type { Repositories } from "../db/repositories/index.ts";
import type { Titler } from "../llm/small/title.ts";
import type { Usage } from "../llm/types.ts";

const TITLE_TIMEOUT_MS = 3000;
const TITLE_CHARS = 60;

export const cleanTitle = (text: string) =>
  (text.trim().split("\n")[0] ?? "")
    .replace(/^title\s*:\s*/i, "")
    .replace(/^[\s"'“”*#]+|[\s"'“”*.]+$/g, "")
    .slice(0, TITLE_CHARS)
    .trim();

/** Runs beside the first reply, so the chat is named by the time the answer ends. A failure leaves the opening question as its name. */
export async function nameChat(store: Repositories, title: Titler, threadId: string, message: string): Promise<Usage> {
  const { text, usage } = await title(message.slice(0, 2000), AbortSignal.timeout(TITLE_TIMEOUT_MS));
  const name = cleanTitle(text);
  if (name) store.threads.saveTitle(threadId, name);
  return usage;
}
