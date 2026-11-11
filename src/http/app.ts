import type { RequestListener, ServerResponse } from "node:http";
import type { ChatDeps } from "../services/chat.ts";
import type { SettingsManager } from "../services/settings.ts";
import { TemporaryChats } from "../services/temporary-chats.ts";
import { RunRegistry } from "../streaming/runs.ts";
import { isLocalRequest } from "./request.ts";
import { handleChat, handleStop, handleStream } from "./routes/chat.ts";
import { handleSettings } from "./routes/settings.ts";
import { changeThread, getThread, listThreads } from "./routes/threads.ts";
import { getTrace, listTraces } from "./routes/traces.ts";
import { serveStatic } from "./static.ts";

export interface AppDeps extends ChatDeps {
  settings?: SettingsManager;
}

/** Routes only. Each handler parses its input and hands the work to a service or repository. */
export function createApp(deps: AppDeps): RequestListener {
  const runs = new RunRegistry();
  const temporaryChats = new TemporaryChats();
  const fail = (res: ServerResponse) => (err: unknown) => {
    console.error(err);
    res.destroy();
  };

  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;

    if (url.pathname.startsWith("/api/") && !isLocalRequest(req)) res.writeHead(403).end("Forbidden");
    else if (url.pathname.startsWith("/api/settings") && deps.settings) handleSettings(req, res, url, deps.settings, deps.guard).catch(fail(res));
    else if (route === "POST /api/chat") handleChat(req, res, deps, runs, temporaryChats).catch(fail(res));
    else if (route === "POST /api/stop") handleStop(req, res, runs).catch(fail(res));
    else if (route === "GET /api/stream") handleStream(res, url, runs);
    else if (route === "GET /api/threads") listThreads(res, deps.store);
    else if (route === "GET /api/thread") getThread(res, url, deps.store);
    else if (route === "GET /api/traces") listTraces(res, deps.store);
    else if (route === "GET /api/trace") getTrace(res, url, deps.store);
    else if (route === "PATCH /api/thread" || route === "DELETE /api/thread") changeThread(req, res, deps.store, runs, (deps.now ?? Date.now)()).catch(fail(res));
    else if (req.method === "GET") serveStatic(res, url.pathname);
    else res.writeHead(404).end("Not found");
  };
}
