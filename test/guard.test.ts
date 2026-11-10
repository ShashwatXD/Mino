import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { DEFAULT_MODELS, loadConfig, type Limits } from "../src/config.ts";
import { costOf, SpendGuard } from "../src/guard.ts";
import { createApp } from "../src/server.ts";
import { Store } from "../src/store.ts";

const limits: Limits = { dailyBudgetUsd: 1, maxPerMinute: 3, maxPerDay: 5, maxConcurrent: 2 };

test("defaults are cheap and safe", () => {
  assert.equal(DEFAULT_MODELS.anthropic, "claude-sonnet-5-5");
  assert.deepEqual(loadConfig({}).limits, { dailyBudgetUsd: 1, maxPerMinute: 10, maxPerDay: 200, maxConcurrent: 2 });
});

test("limits can be set from the environment and are validated", () => {
  assert.equal(loadConfig({ DAILY_BUDGET_USD: "0.25" }).limits.dailyBudgetUsd, 0.25);
  assert.throws(() => loadConfig({ DAILY_BUDGET_USD: "lots" }), /DAILY_BUDGET_USD/);
});

test("cost uses each model's price and counts searches", () => {
  assert.equal(costOf({ model: "claude-sonnet-5-5", inputTokens: 1_000_000, outputTokens: 0, searches: 0 }), 2);
  assert.equal(costOf({ model: "claude-sonnet-5-5", inputTokens: 0, outputTokens: 1_000_000, searches: 0 }), 10);
  assert.ok(Math.abs(costOf({ model: "gemini-3.1-flash-lite", inputTokens: 0, outputTokens: 0, searches: 10 }) - 0.14) < 1e-9);
});

test("an unknown model is priced high rather than treated as free", () => {
  assert.equal(costOf({ model: "some-new-model", inputTokens: 1_000_000, outputTokens: 0, searches: 0 }), 10);
});

test("spending stops at the daily budget and resets the next day", () => {
  const store = new Store(":memory:");
  let now = Date.UTC(2026, 10, 10, 12);
  const guard = new SpendGuard(store, limits, () => now);
  assert.equal(guard.admit(0), null);
  guard.record({ model: "claude-sonnet-5-5", inputTokens: 0, outputTokens: 100_000, searches: 0 });
  now += 61_000;
  assert.match(guard.admit(0) ?? "", /spending limit/);
  now += 2 * 86_400_000;
  assert.equal(guard.admit(0), null);
});

test("the budget survives a restart", () => {
  const store = new Store(":memory:");
  const now = Date.UTC(2026, 10, 10, 12);
  new SpendGuard(store, limits, () => now).record({ model: "claude-sonnet-5-5", inputTokens: 0, outputTokens: 200_000, searches: 0 });
  assert.match(new SpendGuard(store, limits, () => now).admit(0) ?? "", /spending limit/);
});

test("rapid messages are slowed down", () => {
  let now = Date.UTC(2026, 10, 10, 12);
  const guard = new SpendGuard(new Store(":memory:"), limits, () => now);
  for (let i = 0; i < 3; i++) assert.equal(guard.admit(0), null);
  assert.match(guard.admit(0) ?? "", /wait a minute/);
  now += 61_000;
  assert.equal(guard.admit(0), null);
});

test("messages per day and parallel replies are capped", () => {
  let now = Date.UTC(2026, 10, 10, 12);
  const guard = new SpendGuard(new Store(":memory:"), limits, () => now);
  assert.match(guard.admit(2) ?? "", /still running/);
  for (let i = 0; i < 5; i++) {
    assert.equal(guard.admit(0), null);
    now += 61_000;
  }
  assert.match(guard.admit(0) ?? "", /5 messages/);
});

const servers: Server[] = [];
after(() =>
  servers.forEach((s) => {
    s.closeAllConnections();
    s.close();
  }),
);

async function app(run: any, overrides: Partial<Limits> = {}, runTimeoutMs?: number) {
  const store = new Store(":memory:");
  const guard = new SpendGuard(store, { ...limits, ...overrides });
  const server = createServer(createApp({ store, guard, run, runTimeoutMs }));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { store, guard, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const chat = (base: string, threadId: string) =>
  fetch(`${base}/api/chat`, { method: "POST", body: JSON.stringify({ threadId, message: "hello" }) });

test("a refused message never reaches the model or the log", async () => {
  let calls = 0;
  const { base, store } = await app(async () => {
    calls++;
    return { text: "x", sources: [], queries: [], stopReason: "s" };
  }, { dailyBudgetUsd: 0 });
  const res = await chat(base, "t");
  assert.equal(res.status, 429);
  assert.match(await res.text(), /spending limit/);
  assert.equal(calls, 0);
  assert.equal(store.thread("t").length, 0);
});

test("reported usage is added to today's spend", async () => {
  const usage = { model: "claude-sonnet-5-5", inputTokens: 1000, outputTokens: 1000, searches: 1 };
  const { base, guard } = await app(async () => ({ text: "hi", sources: [], queries: [], stopReason: "s", usage }));
  await (await chat(base, "t")).text();
  assert.ok(Math.abs(guard.status().spentUsd - 0.026) < 1e-9, String(guard.status().spentUsd));
  assert.equal(guard.status().messages, 1);
});

test("a stopped reply is still charged an estimate", async () => {
  const run = (o: any) =>
    new Promise((_, reject) => {
      o.emit({ type: "text", text: "x".repeat(4000) });
      o.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const { base, guard } = await app(run, {}, 30);
  const body = await (await chat(base, "t")).text();
  assert.match(body, /took too long/);
  assert.ok(guard.status().spentUsd > 0);
});

test("a reply with no text charges nothing, like a rejected key", async () => {
  const { base, guard } = await app(async () => {
    throw Object.assign(new Error("bad"), { status: 401 });
  });
  await (await chat(base, "t")).text();
  assert.equal(guard.status().spentUsd, 0);
});
