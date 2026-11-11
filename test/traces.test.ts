import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { createRepositories } from "../src/db/repositories/index.ts";
import type { Trace } from "../src/domain/trace.ts";
import { createApp } from "../src/http/app.ts";
import type { TurnOptions } from "../src/llm/types.ts";

const servers: Server[] = [];
after(() =>
  servers.forEach((s) => {
    s.closeAllConnections();
    s.close();
  }),
);

/** A fake model that looks up history once, streams text, and reports usage, like a real reply. */
async function app() {
  const store = createRepositories(":memory:");
  store.turns.save({ threadId: "old", createdAt: Date.UTC(2026, 10, 3, 6), userText: "Compare Postgres hosting", assistantText: "Neon $19", sources: [], queries: [], status: "ok" });
  const run = async (options: TurnOptions) => {
    options.searchHistory?.({ query: "postgres", from: "2026-11-03" });
    options.emit({ type: "search", query: "neon pricing" });
    await new Promise((r) => setTimeout(r, 5));
    options.emit({ type: "text", text: "Still $19." });
    return { text: "Still $19.", sources: [], queries: ["neon pricing"], stopReason: "end_turn", usage: { model: "gemini-3.8-flash", inputTokens: 1000, outputTokens: 100, searches: 1 } };
  };
  const server = createServer(createApp({ store, run, currentModel: () => "gemini-3.8-flash" }));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const chat = (threadId: string, incognito?: boolean) =>
    fetch(`${base}/api/chat`, { method: "POST", body: JSON.stringify({ threadId, message: "Has Neon pricing changed?", incognito }) }).then((r) => r.text());
  return { store, base, chat };
}

test("a reply is saved as a trace with its steps, timings and cost", async () => {
  const { store, chat } = await app();
  await chat("t1");
  const [trace] = store.traces.ofThread("t1");
  assert.equal(trace.status, "ok");
  assert.equal(trace.model, "gemini-3.8-flash");
  assert.equal(trace.historyCalls, 1);
  assert.equal(trace.webSearches, 1);
  assert.ok(trace.firstTokenMs !== null && trace.firstTokenMs <= trace.totalMs);
  assert.ok(trace.costUsd > 0);
  assert.deepEqual([...new Set(trace.spans.map((s) => s.name))].sort(), ["build_prompt", "model", "search_history", "web_search"]);
  const lookup = trace.spans.find((s) => s.name === "search_history")!;
  assert.equal(lookup.attributes.from, "2026-11-03");
  assert.match(String(lookup.attributes.result), /^Turns 1–1 of 1/);
});

test("the API lists traces without their steps, and returns one in full", async () => {
  const { base, chat } = await app();
  await chat("t1");
  const list: Trace[] = await (await fetch(`${base}/api/traces`)).json();
  assert.equal(list.length, 1);
  assert.equal((list[0] as Partial<Trace>).spans, undefined);
  const full: Trace = await (await fetch(`${base}/api/trace?id=${list[0].id}`)).json();
  assert.ok(full.spans.length >= 4);
  assert.equal((await fetch(`${base}/api/trace?id=missing`)).status, 404);
});

test("a temporary chat leaves no trace", async () => {
  const { store, chat } = await app();
  await chat("temp", true);
  assert.deepEqual(store.traces.list(), []);
});

test("deleting a chat deletes its traces", async () => {
  const { store, base, chat } = await app();
  await chat("t1");
  await fetch(`${base}/api/thread`, { method: "DELETE", body: JSON.stringify({ threadId: "t1" }) });
  assert.deepEqual(store.traces.list(), []);
});
