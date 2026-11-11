import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContext } from "../src/context/build.ts";
import { runTurn } from "../src/llm/providers/anthropic.ts";
import { createRepositories, type Repositories } from "../src/db/repositories/index.ts";

const TZ = "Asia/Kolkata";
const NOW = Date.UTC(2026, 10, 10, 6, 30);
const NOV3 = Date.UTC(2026, 10, 3, 6, 30);
const NOV9 = Date.UTC(2026, 10, 9, 6, 30);

const add = (store: Repositories, at: number, userText: string, assistantText = "ok") =>
  store.turns.save({ threadId: "old", createdAt: at, userText, assistantText, sources: [], queries: [], status: "ok" });

const build = (store: Repositories, text: string) =>
  buildContext({ store, text, now: NOW, tz: TZ, threadId: "current", history: [], excludeIds: new Set() });

for (const text of [
  "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
  "What did I ask you on 3 November? Is your answer still correct today?",
  "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
]) {
  test(`the brief's example finds its chat and asks for a re-check: ${text.slice(0, 32)}`, () => {
    const store = createRepositories(":memory:");
    add(store, NOV3, "Compare Postgres hosting prices", "Neon $19");
    add(store, NOV9, "Shortlist CRM tools for sales", "HubSpot, Pipedrive, Close, Zoho, Freshsales");
    const built = build(store, text);
    assert.equal(built.maxSearches, 8);
    assert.ok(built.found.turns.length > 0);
    assert.match(built.context, /re-checked/);
  });
}

test("an ordinary question keeps the normal search cap", () => {
  assert.equal(build(createRepositories(":memory:"), "How does MVCC work in databases?").maxSearches, 4);
});

test("a re-check on nothing stays at the normal search cap", async () => {
  const built = await build(createRepositories(":memory:"), "What did I ask on 1 January? Has any pricing changed?");
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

test("a misspelled date with no chats that day says nothing is on record", () => {
  const built = build(createRepositories(":memory:"), "What did I ask on 3 novbber?");
  assert.match(built.context, /holds nothing/);
});

