import type { ServerResponse } from "node:http";
import type { Run } from "./runs.ts";

const HEARTBEAT_MS = 15_000;

/** Sends a run over SSE from `after`. Closing the connection stops watching, never the reply. */
export function attach(res: ServerResponse, run: Run, after: number): void {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  // Headers go out now, or the browser waits for the first token before it sees any response.
  res.flushHeaders();
  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  heartbeat.unref();
  let unsubscribe = () => {};
  res.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
  unsubscribe = run.subscribe(after, (event) => {
    if (event) res.write(`data: ${JSON.stringify(event)}\n\n`);
    else {
      clearInterval(heartbeat);
      res.end();
    }
  });
}
