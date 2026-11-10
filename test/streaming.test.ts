import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import type { TurnOptions } from "../src/engines/shared.ts";
import { Run } from "../src/runs.ts";
import { createApp } from "../src/server.ts";
import { Store } from "../src/store.ts";

const servers: Server[] = [];
after(() =>
  servers.forEach((s) => {
    s.closeAllConnections();
    s.close();
  }),
);

/** A reply the test advances by hand, standing in for a model. */
function controlledEngine() {
  let options!: TurnOptions;
  let resolve!: (r: unknown) => void;
  let reject!: (e: unknown) => void;
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  const run = (o: TurnOptions) => {
    options = o;
    o.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    started();
    return new Promise((res, rej) => ((resolve = res), (reject = rej))) as any;
  };
  return {
    run,
    ready,
    text: (t: string) => options.emit({ type: "text", text: t }),
    complete: (text: string) => resolve({ text, sources: [], queries: [], stopReason: "end_turn" }),
  };
}

async function start(engine: ReturnType<typeof controlledEngine>, store = new Store(":memory:")) {
  const server = createServer(createApp({ store, run: engine.run, draftMs: 5 }));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { store, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const post = (base: string, path: string, body: unknown, signal?: AbortSignal) =>
  fetch(base + path, { method: "POST", body: JSON.stringify(body), signal });

/** Reads SSE events until `until` matches or the stream ends. */
async function collect(res: Response, until: (e: any) => boolean) {
  const events: any[] = [];
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return events;
    buffer += value;
    const parts = buffer.split("\n\n");
    buffer = parts.pop()!;
    for (const p of parts) {
      if (!p.startsWith("data: ")) continue;
      const e = JSON.parse(p.slice(6));
      events.push(e);
      if (until(e)) {
        await reader.cancel();
        return events;
      }
    }
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("leaving the page does not stop the reply, and rejoining replays it", async () => {
  const engine = controlledEngine();
  const { base, store } = await start(engine);
  const leaving = new AbortController();
  const res = await post(base, "/api/chat", { threadId: "t", message: "hello" }, leaving.signal);
  await engine.ready;
  engine.text("Hel");
  await collect(res, (e) => e.type === "text");
  leaving.abort();
  await wait(20);

  engine.text("lo");
  const rejoin = await fetch(`${base}/api/stream?threadId=t&after=0`);
  assert.equal(rejoin.status, 200);
  setTimeout(() => engine.complete("Hello"), 20);
  const events = await collect(rejoin, (e) => e.type === "done");
  assert.equal(events.filter((e) => e.type === "text").map((e) => e.text).join(""), "Hello");
  await wait(10);
  assert.equal(store.thread("t")[0].status, "ok");
  assert.equal(store.thread("t")[0].assistantText, "Hello");
});

test("resuming from a sequence number never repeats text", async () => {
  const engine = controlledEngine();
  const { base } = await start(engine);
  const res = await post(base, "/api/chat", { threadId: "t", message: "hello" });
  await engine.ready;
  engine.text("A");
  const first = await collect(res, (e) => e.type === "text");
  engine.text("B");
  const resume = await fetch(`${base}/api/stream?threadId=t&after=${first.at(-1).seq}`);
  setTimeout(() => engine.complete("AB"), 20);
  const events = await collect(resume, (e) => e.type === "done");
  assert.deepEqual(events.filter((e) => e.type === "text").map((e) => e.text), ["B"]);
});

test("a finished reply reports nothing to rejoin", async () => {
  const engine = controlledEngine();
  const { base } = await start(engine);
  const res = await post(base, "/api/chat", { threadId: "t", message: "hello" });
  await engine.ready;
  engine.complete("Done");
  await collect(res, (e) => e.type === "done");
  await wait(10);
  assert.equal((await fetch(`${base}/api/stream?threadId=t`)).status, 204);
});

test("stop keeps the text that already arrived", async () => {
  const engine = controlledEngine();
  const { base, store } = await start(engine);
  const res = await post(base, "/api/chat", { threadId: "t", message: "hello" });
  await engine.ready;
  engine.text("Partial");
  setTimeout(() => post(base, "/api/stop", { threadId: "t" }), 20);
  const events = await collect(res, (e) => e.type === "stopped");
  assert.equal(events.at(-1).type, "stopped");
  await wait(10);
  const turn = store.thread("t")[0];
  assert.equal(turn.status, "interrupted");
  assert.equal(turn.assistantText, "Partial");
});

test("a second send in the same chat is refused while one is running", async () => {
  const engine = controlledEngine();
  const { base, store } = await start(engine);
  const res = await post(base, "/api/chat", { threadId: "t", message: "one" });
  await engine.ready;
  const second = await post(base, "/api/chat", { threadId: "t", message: "two" });
  assert.equal(second.status, 409);
  assert.equal(store.thread("t").length, 1);
  engine.complete("ok");
  await collect(res, (e) => e.type === "done");
});

test("the question and partial text are on disk during the reply", async () => {
  const engine = controlledEngine();
  const { base, store } = await start(engine);
  const res = await post(base, "/api/chat", { threadId: "t", message: "hello" });
  await engine.ready;
  assert.equal(store.thread("t")[0].status, "streaming");
  engine.text("Draft");
  await wait(30);
  assert.equal(store.thread("t")[0].assistantText, "Draft");
  engine.complete("Draft done");
  await collect(res, (e) => e.type === "done");
});

test("a reply left streaming by a crash is recovered as interrupted and searchable", () => {
  const store = new Store(":memory:");
  const id = store.begin("t", 1000, "Compare Postgres hosting");
  store.updateDraft(id, "Neon starts at");
  assert.equal(store.recoverInterrupted(), 1);
  const turn = store.thread("t")[0];
  assert.equal(turn.status, "interrupted");
  assert.equal(turn.assistantText, "Neon starts at");
  assert.equal(store.search(["neon"]).length, 1);
});

test("chats are listed by latest activity and titled by their first question", () => {
  const store = new Store(":memory:");
  const save = (threadId: string, createdAt: number, userText: string) =>
    store.save({ threadId, createdAt, userText, assistantText: "a", sources: [], queries: [], status: "ok" });
  save("a", 1, "First chat opening");
  save("b", 2, "Second chat opening");
  save("a", 3, "First chat follow-up");
  assert.deepEqual(store.threads(), [
    { threadId: "a", title: "First chat opening", updatedAt: 3 },
    { threadId: "b", title: "Second chat opening", updatedAt: 2 },
  ]);
});

test("a late subscriber to a finished run gets the replay and the end", () => {
  const run = new Run("t");
  run.emit({ type: "text", text: "x" });
  run.close();
  const seen: unknown[] = [];
  run.subscribe(0, (e) => seen.push(e));
  assert.equal(seen.length, 2);
  assert.equal(seen[1], null);
});
