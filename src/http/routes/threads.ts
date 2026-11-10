import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Repositories } from "../../db/repositories/index.ts";
import type { RunRegistry } from "../../streaming/runs.ts";
import { readJson, sendJson } from "../request.ts";

const ThreadChangeSchema = z.object({ threadId: z.string().min(1).max(100), pinned: z.boolean().optional() });

export function listThreads(res: ServerResponse, store: Repositories): void {
  sendJson(res, 200, store.threads.list());
}

export function getThread(res: ServerResponse, url: URL, store: Repositories): void {
  sendJson(res, 200, store.turns.ofThread((url.searchParams.get("id") ?? "").slice(0, 100)));
}

export async function changeThread(req: IncomingMessage, res: ServerResponse, store: Repositories, runs: RunRegistry, now: number): Promise<void> {
  const body = await readJson(req, res, ThreadChangeSchema);
  if (!body) return;
  if (req.method === "DELETE") {
    // A reply still running writes to its turn by id, so once the rows are gone those writes do nothing.
    runs.get(body.threadId)?.abort.abort();
    store.threads.delete(body.threadId);
  } else if (body.pinned === undefined) {
    res.writeHead(400).end("Invalid request");
    return;
  } else {
    store.threads.setPinned(body.threadId, body.pinned, now);
  }
  res.writeHead(204).end();
}
