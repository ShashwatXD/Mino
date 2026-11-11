import type { ServerResponse } from "node:http";
import type { Repositories } from "../../db/repositories/index.ts";
import { sendJson } from "../request.ts";

export function listTraces(res: ServerResponse, store: Repositories): void {
  sendJson(res, 200, store.traces.list());
}

export function getTrace(res: ServerResponse, url: URL, store: Repositories): void {
  const trace = store.traces.get((url.searchParams.get("id") ?? "").slice(0, 100));
  if (trace) sendJson(res, 200, trace);
  else sendJson(res, 404, { error: "No trace has that id." });
}
