import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { ChatRequestSchema } from "../../config/config.ts";
import { startChat, type ChatDeps } from "../../services/chat.ts";
import type { TemporaryChats } from "../../services/temporary-chats.ts";
import type { RunRegistry } from "../../streaming/runs.ts";
import { attach } from "../../streaming/sse.ts";
import { readJson } from "../request.ts";

const ThreadSchema = z.object({ threadId: z.string().min(1).max(100) });
const StreamQuerySchema = ThreadSchema.extend({ after: z.coerce.number().int().min(0).default(0) });

export async function handleChat(req: IncomingMessage, res: ServerResponse, deps: ChatDeps, runs: RunRegistry, temporaryChats: TemporaryChats): Promise<void> {
  const request = await readJson(req, res, ChatRequestSchema);
  if (!request) return;
  const started = startChat(deps, runs, temporaryChats, request);
  if ("status" in started) res.writeHead(started.status).end(started.message);
  else attach(res, started.run, 0);
}

export async function handleStop(req: IncomingMessage, res: ServerResponse, runs: RunRegistry): Promise<void> {
  const body = await readJson(req, res, ThreadSchema);
  if (!body) return;
  runs.get(body.threadId)?.abort.abort();
  res.writeHead(204).end();
}

/** A tab that reconnects resumes from the last event it saw. 204 means the reply already ended. */
export function handleStream(res: ServerResponse, url: URL, runs: RunRegistry): void {
  const query = StreamQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success) {
    res.writeHead(400).end("Invalid request");
    return;
  }
  const run = runs.get(query.data.threadId);
  if (run) attach(res, run, query.data.after);
  else res.writeHead(204).end();
}
