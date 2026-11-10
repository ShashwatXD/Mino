import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatRequestSchema, ConfigError, loadConfig } from "./config.ts";
import { createEngine } from "./engines/index.ts";
import type { AgentEvent, TurnOptions, TurnResult } from "./engines/shared.ts";
import { recall, renderContext } from "./memory.ts";
import { Store } from "./store.ts";
import { safeTimeZone } from "./time.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));

const MAX_BODY = 64 * 1024;
const HISTORY_TURNS = 12;
const NO_KEY_MESSAGE = "No usable API key found. Add GEMINI_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY to .env and restart.";

const STATIC_FILES: Record<string, [string, string]> = {
  "/": ["public/index.html", "text/html; charset=utf-8"],
  "/vendor/marked.js": ["node_modules/marked/marked.min.js", "text/javascript; charset=utf-8"],
  "/vendor/purify.js": ["node_modules/dompurify/dist/purify.min.js", "text/javascript; charset=utf-8"],
};

class NoEngineError extends Error {}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new Error("too large");
  }
  return body;
}

/** All three SDKs expose an HTTP status, so one mapping covers every engine. */
export function friendlyError(err: unknown): string {
  if (err instanceof NoEngineError) return NO_KEY_MESSAGE;
  const status = (err as { status?: unknown })?.status;
  const message = err instanceof Error ? err.message : "";
  if (status === 401 || /API[ _]KEY[ _](NOT[ _]VALID|INVALID)/i.test(message)) return "The API key was rejected. Check it in .env.";
  if (status === 403) return "This API key cannot use the configured model or web search.";
  if (status === 404) return "The configured model was not found. Check MODEL in .env.";
  if (status === 429) return "The model is rate limited right now. Please try again shortly.";
  if (typeof status === "number") return `The model request failed (${status}). Please try again.`;
  if (/fetch failed|connection|network|ENOTFOUND|ECONN/i.test(message)) return "Could not reach the model. Check the network connection.";
  return "Something went wrong while answering. Please try again.";
}

export interface AppDeps {
  store: Store;
  run: (options: TurnOptions) => Promise<TurnResult>;
  now?: () => number;
}

export async function handleChat(req: IncomingMessage, res: ServerResponse, deps: AppDeps): Promise<void> {
  let json: unknown;
  try {
    json = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400).end("Invalid request");
    return;
  }
  const parsed = ChatRequestSchema.safeParse(json);
  if (!parsed.success) {
    res.writeHead(400).end(parsed.error.issues[0].message);
    return;
  }

  const { message: userText, timezone } = parsed.data;
  const threadId = parsed.data.threadId ?? randomUUID();
  const tz = safeTimeZone(timezone);
  const now = (deps.now ?? Date.now)();

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event: AgentEvent | { type: "done"; threadId: string } | { type: "error"; text: string }) =>
    res.write(`data: ${JSON.stringify(event)}\n\n`);

  const abort = new AbortController();
  res.on("close", () => abort.abort());

  const history = deps.store.thread(threadId, HISTORY_TURNS).filter((t) => t.status === "ok");
  const found = recall(deps.store, userText, now, tz, new Set(history.map((t) => t.id)));
  if (found.lookedUp) send({ type: "status", text: "Checking our past conversations" });
  const context = renderContext(found, now, tz);

  let text = "";
  const collect = (event: AgentEvent) => {
    if (event.type === "text") text += event.text;
    send(event);
  };

  try {
    const result = await deps.run({ history, userText, context, tz, emit: collect, signal: abort.signal });
    deps.store.save({
      threadId,
      createdAt: now,
      userText,
      assistantText: result.text,
      sources: result.sources,
      queries: result.queries,
      status: "ok",
    });
    send({ type: "done", threadId });
  } catch (err) {
    const interrupted = abort.signal.aborted;
    // The question is kept even when the answer fails, so "what did I ask" stays truthful.
    deps.store.save({
      threadId,
      createdAt: now,
      userText,
      assistantText: text,
      sources: [],
      queries: [],
      status: interrupted ? "interrupted" : "failed",
    });
    if (!interrupted) {
      if (!(err instanceof NoEngineError)) console.error(err);
      send({ type: "error", text: friendlyError(err) });
    }
  }
  res.end();
}

function main(): void {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  for (const warning of config.warnings) console.warn(warning);

  const engine = createEngine(config);
  if (engine) console.log(`Engine: ${engine.provider} (${engine.model})`);
  else console.warn(NO_KEY_MESSAGE);

  const store = new Store(join(root, "data", "memory.db"));
  const deps: AppDeps = {
    store,
    run: (options) => (engine ? engine.run(options) : Promise.reject(new NoEngineError())),
  };

  createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/api/chat") {
      handleChat(req, res, deps).catch((err) => {
        console.error(err);
        res.destroy();
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/thread") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(store.thread(url.searchParams.get("id") ?? "")));
      return;
    }
    const file = req.method === "GET" ? STATIC_FILES[url.pathname] : undefined;
    if (file) {
      res.writeHead(200, { "Content-Type": file[1] });
      res.end(readFileSync(join(root, file[0])));
      return;
    }
    res.writeHead(404).end("Not found");
  }).listen(config.port, "127.0.0.1", () => console.log(`Chat agent running at http://localhost:${config.port}`));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
