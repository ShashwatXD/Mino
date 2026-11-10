import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ChatRequestSchema, ConfigError, loadConfig } from "./config.ts";
import type { AgentEvent, TurnOptions, TurnResult } from "./engines/shared.ts";
import { estimateTokens, SpendGuard } from "./guard.ts";
import { extractFacts, fitHistory, recall, renderContext } from "./memory.ts";
import { Run, RunRegistry } from "./runs.ts";
import { RemoveKeySchema, SetKeySchema, SetModelSchema, SettingsError, SettingsManager } from "./settings.ts";
import { Store } from "./store.ts";
import { safeTimeZone } from "./time.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));

const MAX_BODY = 64 * 1024;
const HISTORY_TURNS = 20;
const DRAFT_DEBOUNCE_MS = 400;
const HEARTBEAT_MS = 15_000;
const RUN_TIMEOUT_MS = 180_000;
const NO_KEY_MESSAGE = "No API key added yet. Open Settings to add one.";

const STATIC_FILES: Record<string, [string, string]> = {
  "/": ["public/index.html", "text/html; charset=utf-8"],
  "/settings": ["public/settings.html", "text/html; charset=utf-8"],
  "/styles.css": ["public/styles.css", "text/css; charset=utf-8"],
  "/vendor/marked.js": ["node_modules/marked/marked.min.js", "text/javascript; charset=utf-8"],
  "/vendor/purify.js": ["node_modules/dompurify/dist/purify.min.js", "text/javascript; charset=utf-8"],
};

const StopSchema = z.object({ threadId: z.string().min(1).max(100) });
const StreamQuerySchema = z.object({
  threadId: z.string().min(1).max(100),
  after: z.coerce.number().int().min(0).default(0),
});

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
  if (status === 401 || /API[ _]KEY[ _](NOT[ _]VALID|INVALID)/i.test(message)) return "The API key was rejected. Check it in Settings.";
  if (status === 402) return "This API key has no credits left. Add credits in your provider's billing page, or switch provider in Settings.";
  if (status === 403) return "This API key cannot use the configured model or web search.";
  if (status === 404) return "This model was not found. Choose another one in Settings.";
  if (status === 429) return "The model is rate limited right now. Please try again shortly.";
  if (typeof status === "number") return `The model request failed (${status}). Please try again.`;
  if (/fetch failed|connection|network|ENOTFOUND|ECONN/i.test(message)) return "Could not reach the model. Check the network connection.";
  return "Something went wrong while answering. Please try again.";
}

export interface AppDeps {
  store: Store;
  run: (options: TurnOptions) => Promise<TurnResult>;
  settings?: SettingsManager;
  guard?: SpendGuard;
  runTimeoutMs?: number;
  currentModel?: () => string;
  now?: () => number;
  draftMs?: number;
}

/** Sends a run over SSE from `after`. Closing the connection stops watching, never the reply. */
function attach(res: ServerResponse, run: Run, after: number): void {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  // Headers go out now, or the browser waits for the first token before it sees any response.
  res.flushHeaders();
  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  heartbeat.unref();
  let unsubscribe = () => {};
  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  res.on("close", cleanup);
  unsubscribe = run.subscribe(after, (event) => {
    if (event) res.write(`data: ${JSON.stringify(event)}\n\n`);
    else {
      clearInterval(heartbeat);
      res.end();
    }
  });
}

function startReply(deps: AppDeps, runs: RunRegistry, run: Run, turnId: number, options: Omit<TurnOptions, "emit" | "signal">): void {
  let text = "";
  let timer: NodeJS.Timeout | null = null;
  let searches = 0;
  let timedOut = false;
  // A hung provider must not hold a reply, or its cost, open forever.
  const deadline = setTimeout(() => {
    timedOut = true;
    run.abort.abort();
  }, deps.runTimeoutMs ?? RUN_TIMEOUT_MS);
  deadline.unref();
  const debounce = deps.draftMs ?? DRAFT_DEBOUNCE_MS;

  // Tokens stay in memory and reach disk on a debounce, so storage never slows the stream.
  const flushLater = () => {
    timer ??= setTimeout(() => {
      timer = null;
      deps.store.updateDraft(turnId, text);
    }, debounce);
  };
  const clearDraftTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const emit = (event: AgentEvent) => {
    if (event.type === "text") {
      text += event.text;
      flushLater();
    }
    if (event.type === "search") searches++;
    run.emit(event);
  };

  (async () => {
    try {
      const result = await deps.run({ ...options, emit, signal: run.abort.signal });
      clearDraftTimer();
      deps.store.finish(turnId, { assistantText: result.text, sources: result.sources, queries: result.queries, status: "ok" });
      if (result.usage) deps.guard?.record(result.usage);
      run.emit({ type: "done", threadId: run.threadId });
    } catch (err) {
      clearDraftTimer();
      const stopped = run.abort.signal.aborted;
      // What already arrived is kept, and the question stays on record either way.
      deps.store.finish(turnId, { assistantText: text, sources: [], queries: [], status: stopped ? "interrupted" : "failed" });
      // A reply cut short never reports usage, so what it visibly consumed is estimated.
      if (text) {
        const prompt = options.history.reduce((n, t) => n + t.userText.length + t.assistantText.length, options.context.length + options.userText.length);
        deps.guard?.record({ model: deps.currentModel?.() ?? "unknown", inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(text.length), searches });
      }
      if (timedOut) run.emit({ type: "error", text: "This reply took too long and was stopped." });
      else if (stopped) run.emit({ type: "stopped" });
      else {
        if (!(err instanceof NoEngineError)) console.error(err);
        run.emit({ type: "error", text: friendlyError(err) });
      }
    } finally {
      clearTimeout(deadline);
      runs.finish(run);
    }
  })();
}

async function handleChat(req: IncomingMessage, res: ServerResponse, deps: AppDeps, runs: RunRegistry): Promise<void> {
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
  const run = runs.start(threadId);
  if (!run) {
    res.writeHead(409).end("A reply is already in progress in this chat.");
    return;
  }
  const refused = deps.guard?.admit(runs.count - 1);
  if (refused) {
    runs.finish(run);
    res.writeHead(429).end(refused);
    return;
  }

  const tz = safeTimeZone(timezone);
  const now = (deps.now ?? Date.now)();
  for (const fact of extractFacts(userText)) deps.store.saveFact(fact.key, fact.value, now);
  const history = fitHistory(deps.store.thread(threadId, HISTORY_TURNS).filter((t) => t.status === "ok" || t.status === "interrupted"));
  const found = recall(deps.store, userText, now, tz, new Set(history.map((t) => t.id)));
  if (found.lookedUp) {
    run.emit({ type: "memory", refs: found.refs, found: found.turns.length + found.inHistory, outsideWindow: found.outsideWindow });
  }
  const context = renderContext(found, now, tz, deps.store.facts());
  const turnId = deps.store.begin(threadId, now, userText);

  attach(res, run, 0);
  startReply(deps, runs, run, turnId, { history, userText, context, tz });
}

async function handleStop(req: IncomingMessage, res: ServerResponse, runs: RunRegistry): Promise<void> {
  let json: unknown;
  try {
    json = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400).end("Invalid request");
    return;
  }
  const parsed = StopSchema.safeParse(json);
  if (!parsed.success) {
    res.writeHead(400).end("Invalid request");
    return;
  }
  runs.get(parsed.data.threadId)?.abort.abort();
  res.writeHead(204).end();
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** Stops other websites, and DNS rebinding, from driving this local API from the user's browser. */
function isLocalRequest(req: IncomingMessage): boolean {
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

async function handleSettings(req: IncomingMessage, res: ServerResponse, settings: SettingsManager, url: URL, guard?: SpendGuard): Promise<void> {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === "GET /api/settings") {
      if (url.searchParams.has("refresh")) await settings.refreshModels();
      reply(200, { ...settings.snapshot(), usage: guard?.status() });
      return;
    }
    const raw = await readBody(req);
    const json: unknown = JSON.parse(raw || "null");
    let verified: boolean | undefined;
    if (route === "POST /api/settings/key") {
      const body = SetKeySchema.parse(json);
      verified = (await settings.setKey(body.provider, body.key)).verified;
    } else if (route === "DELETE /api/settings/key") {
      settings.removeKey(RemoveKeySchema.parse(json).provider);
    } else if (route === "POST /api/settings/model") {
      const body = SetModelSchema.parse(json);
      settings.setModel(body.provider, body.model);
    } else {
      reply(404, { error: "Not found" });
      return;
    }
    reply(200, { ...settings.snapshot(), usage: guard?.status(), verified });
  } catch (err) {
    if (err instanceof SettingsError) reply(400, { error: err.message });
    else if (err instanceof z.ZodError || err instanceof SyntaxError) reply(400, { error: "Invalid request" });
    else throw err;
  }
}

export function createApp(deps: AppDeps): RequestListener {
  const runs = new RunRegistry();

  const fail = (res: ServerResponse) => (err: unknown) => {
    console.error(err);
    res.destroy();
  };

  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;

    if (url.pathname.startsWith("/api/") && !isLocalRequest(req)) {
      res.writeHead(403).end("Forbidden");
    } else if (url.pathname.startsWith("/api/settings") && deps.settings) {
      handleSettings(req, res, deps.settings, url, deps.guard).catch(fail(res));
    } else if (route === "POST /api/chat") {
      handleChat(req, res, deps, runs).catch(fail(res));
    } else if (route === "POST /api/stop") {
      handleStop(req, res, runs).catch(fail(res));
    } else if (route === "GET /api/stream") {
      const query = StreamQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success) {
        res.writeHead(400).end("Invalid request");
        return;
      }
      const run = runs.get(query.data.threadId);
      if (run) attach(res, run, query.data.after);
      else res.writeHead(204).end();
    } else if (route === "GET /api/threads") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(deps.store.threads()));
    } else if (route === "GET /api/thread") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(deps.store.thread((url.searchParams.get("id") ?? "").slice(0, 100))));
    } else {
      const file = req.method === "GET" ? STATIC_FILES[url.pathname] : undefined;
      if (file) {
        res.writeHead(200, { "Content-Type": file[1] });
        res.end(readFileSync(join(root, file[0])));
      } else {
        res.writeHead(404).end("Not found");
      }
    }
  };
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

  const settings = new SettingsManager(join(root, "data", "settings.json"), config);
  const active = settings.active();
  if (active) console.log(`Engine: ${active.provider} (${active.model})`);
  else console.warn("No API key yet. Add one in the app or in .env.");

  const store = new Store(join(root, "data", "memory.db"));
  store.recoverInterrupted();

  const listener = createApp({
    store,
    settings,
    guard: new SpendGuard(store, config.limits),
    currentModel: () => settings.active()?.model ?? "unknown",
    run: (options) => settings.engine()?.run(options) ?? Promise.reject(new NoEngineError()),
  });

  createServer(listener).listen(config.port, "127.0.0.1", () => console.log(`Chat agent running at http://localhost:${config.port}`));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
