import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContext, needsUnderstanding, type Helpers } from "../src/context.ts";
import { runTurn } from "../src/engines/anthropic.ts";
import { recall } from "../src/memory.ts";
import { Store } from "../src/store.ts";

const TZ = "Asia/Kolkata";
const NOW = Date.UTC(2026, 10, 10, 6, 30);
const DAY = 86_400_000;
const NOV3 = Date.UTC(2026, 10, 3, 6, 30);
const NOV9 = Date.UTC(2026, 10, 9, 6, 30);

const add = (store: Store, at: number, userText: string, assistantText = "ok") =>
  store.save({ threadId: "old", createdAt: at, userText, assistantText, sources: [], queries: [], status: "ok" });

const usage = { model: "small", inputTokens: 10, outputTokens: 5, searches: 0 };

function understood(fields: object) {
  const calls: any[] = [];
  const understand: Helpers["understand"] = async (request) => {
    calls.push(request);
    return {
      usage,
      text: JSON.stringify({ intent: "recall", needs_web: false, standalone_query: "q", time_range: null, keywords: [], ...fields }),
    };
  };
  return { understand, calls };
}

const build = (store: Store, text: string, helpers?: Helpers) =>
  buildContext({ store, text, now: NOW, tz: TZ, threadId: "current", history: [], excludeIds: new Set(), helpers });

for (const text of [
  "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
  "What did I ask you on 3 November? Is your answer still correct today?",
  "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
]) {
  test(`the brief's example needs no small model: ${text.slice(0, 32)}`, async () => {
    const store = new Store(":memory:");
    add(store, NOV3, "Compare Postgres hosting prices", "Neon $19");
    add(store, NOV9, "Shortlist CRM tools for sales", "HubSpot, Pipedrive, Close, Zoho, Freshsales");
    const { understand, calls } = understood({});
    const built = await build(store, text, { understand });
    assert.equal(calls.length, 0);
    assert.equal(built.maxSearches, 8);
    assert.ok(built.found.turns.length > 0);
    assert.match(built.context, /re-checked/);
  });
}

test("an ordinary question makes no extra model call", async () => {
  const store = new Store(":memory:");
  const { understand, calls } = understood({});
  const built = await build(store, "How does MVCC work in databases?", { understand });
  assert.equal(calls.length, 0);
  assert.equal(built.maxSearches, 4);
  assert.equal(built.usage.length, 0);
});

test("the gate opens for Hinglish, vague wording, and unmatched references", () => {
  const store = new Store(":memory:");
  const local = (text: string) => recall(store, text, NOW, TZ, new Set());
  assert.equal(needsUnderstanding("kimat badli kya", local("kimat badli kya")), true);
  assert.equal(needsUnderstanding("पिछले मंगल को क्या पूछा", local("पिछले मंगल को क्या पूछा")), true);
  assert.equal(needsUnderstanding("what about that one", local("what about that one")), true);
  assert.equal(needsUnderstanding("what did I ask earlier", local("what did I ask earlier")), true);
  assert.equal(needsUnderstanding("explain vector clocks", local("explain vector clocks")), false);
});

test("a date already found locally skips the small model, even in Hinglish", async () => {
  const store = new Store(":memory:");
  add(store, NOW - DAY, "Compare Postgres hosting");
  const { understand, calls } = understood({});
  await build(store, "kal kya poocha tha", { understand });
  assert.equal(calls.length, 0);
});

test("translated keywords find a chat written in another language", async () => {
  const store = new Store(":memory:");
  add(store, NOV3, "Compare database pricing", "Neon $19");
  const { understand } = understood({ intent: "recall", keywords: ["database", "pricing"] });
  const built = await build(store, "database ki kimat kya thi", { understand });
  assert.match(built.found.turns[0]?.userText ?? "", /database pricing/);
  assert.equal(built.usage.length, 1);
});

test("a time range from the small model selects that day", async () => {
  const store = new Store(":memory:");
  add(store, NOV3, "Pizza dough recipe");
  add(store, NOV9, "Unrelated chat");
  const { understand } = understood({ time_range: { from: "2026-11-03", to: "2026-11-03" } });
  const built = await build(store, "पिछले मंगल को क्या पूछा", { understand });
  assert.deepEqual(built.found.turns.map((t) => t.userText), ["Pizza dough recipe"]);
});

test("recent turns reach the small model, shortened", async () => {
  const store = new Store(":memory:");
  const { understand, calls } = understood({});
  const history = [{ id: 1, threadId: "t", createdAt: NOW, userText: "CRM tools", assistantText: "x".repeat(900), sources: [], queries: [], status: "ok" as const }];
  await buildContext({ store, text: "woh wala batao", now: NOW, tz: TZ, threadId: "t", history, excludeIds: new Set([1]), helpers: { understand } });
  assert.ok(calls[0].recent[0].assistant.length <= 200);
  assert.match(calls[0].recent[0].user, /CRM tools/);
});

for (const [name, understand] of [
  ["fails", async () => { throw new Error("429"); }],
  ["returns invalid JSON", async () => ({ text: "not json", usage })],
  ["returns the wrong shape", async () => ({ text: '{"intent":"launch"}', usage })],
] as const) {
  test(`the reply continues when the small model ${name}`, async () => {
    const store = new Store(":memory:");
    add(store, NOV3, "CRM tools shortlist");
    const built = await build(store, "woh CRM tools wala", { understand: understand as any });
    assert.match(built.found.turns[0]?.userText ?? "", /CRM/);
  });
}

test("a slow small model is cut off instead of delaying the reply", async () => {
  const store = new Store(":memory:");
  const start = performance.now();
  await build(store, "woh wala batao", {
    understand: (_, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
  });
  assert.ok(performance.now() - start < 2000);
});

test("a re-check on nothing stays at the normal search cap", async () => {
  const built = await build(new Store(":memory:"), "Has any pricing changed since 1 January?");
  assert.equal(built.maxSearches, 4);
  assert.match(built.context, /holds nothing/);
});

test("the search cap reaches the answering model", async () => {
  let params: any;
  const client = {
    beta: {
      messages: {
        stream: (p: any) => {
          params = p;
          return { async *[Symbol.asyncIterator]() {}, finalMessage: async () => ({ stop_reason: "end_turn", content: [] }) };
        },
      },
    },
  } as any;
  await runTurn({ client, model: "m", effort: "medium", history: [], userText: "x", context: "c", tz: TZ, emit: () => {}, maxSearches: 8 });
  assert.equal(params.tools.length, 1);
  assert.equal(params.tools[0].max_uses, 8);
});

test("a date with no chats that day skips the small model", async () => {
  const { understand, calls } = understood({});
  const built = await build(new Store(":memory:"), "3 novbber ko kya tha", { understand });
  assert.equal(calls.length, 0);
  assert.match(built.context, /holds nothing/);
});
