import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";

const MAX_BODY = 64 * 1024;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new Error("too large");
  }
  return body;
}

/** Parses the body against a schema, or answers 400 and returns null. */
export async function readJson<T>(req: IncomingMessage, res: ServerResponse, schema: z.ZodType<T>): Promise<T | null> {
  let json: unknown;
  try {
    json = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400).end("Invalid request");
    return null;
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    res.writeHead(400).end(parsed.error.issues[0]?.message ?? "Invalid request");
    return null;
  }
  return parsed.data;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Stops other websites, and DNS rebinding, from driving this local API from the user's browser. */
export function isLocalRequest(req: IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  if (!LOCAL_HOST.test(host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
