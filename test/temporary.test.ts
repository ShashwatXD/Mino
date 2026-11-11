import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { createRepositories } from "../src/db/repositories/index.ts";
import { createApp } from "../src/http/app.ts";
import type { TurnOptions } from "../src/llm/types.ts";
import { TemporaryChats } from "../src/services/temporary-chats.ts";

const servers: Server[] = [];
after(() =>
  servers.forEach((s) => {
    s.closeAllConnections();
    s.close();
  }),
);

async function app() {
  const store = createRepositories(":memory:");
  store.facts.save("location", "Pune", 1);
  store.turns.save({ threadId: "old", createdAt: 1, userText: "Compare Postgres hosting", assistantText: "Neon $19", sources: [], queries: [], status: "ok" });
  const seen: TurnOptions[] = [];
  const helperCalls: string[] = [];
  const server = createServer(
    createApp({
      store,
      helpers: () => ({
        title: async () => (helperCalls.push("title"), { text: "A title", usage: { model: "s", inputTokens: 1, outputTokens: 1, searches: 0 } }),
        summarize: async () => (helperCalls.push("summary"), { text: "A summary", usage: { model: "s", inputTokens: 1, outputTokens: 1, searches: 0 } }),
      }),
      run: async (options) => (seen.push(options), { text: `reply ${seen.length}`, sources: [], queries: [], stopReason: "end_turn" }),
    }),
  );
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const chat = (message: string, incognito?: boolean, threadId = "temp") =>
    fetch(`${base}/api/chat`, { method: "POST", body: JSON.stringify({ threadId, message, incognito }) }).then((r) => r.text());
  return { store, seen, helperCalls, chat, base };
}

test("a temporary chat is never saved, listed or searchable", async () => {
  const { store, chat, base } = await app();
  assert.match(await chat("My name is Riya and I live in Delhi.", true), /"done"/);
  assert.deepEqual(store.turns.ofThread("temp"), []);
  assert.deepEqual(await (await fetch(`${base}/api/threads`)).json().then((t: any[]) => t.map((c) => c.threadId)), ["old"]);
  assert.equal(store.facts.list()[0].value, "Pune", "facts stated in a temporary chat are not saved");
});

test("a temporary chat gets no history tool and no memory in its prompt", async () => {
  const { seen, chat } = await app();
  await chat("What did I ask about Postgres?", true);
  assert.equal(seen[0].searchHistory, undefined);
  assert.doesNotMatch(seen[0].context, /Pune|Postgres|recent_chats|user_facts/);
  assert.match(seen[0].context, /^Current time:/);
});

test("a follow-up in a temporary chat sees the earlier turn", async () => {
  const { seen, chat } = await app();
  await chat("First question", true);
  await chat("And a follow-up", true);
  assert.deepEqual(seen[1].history.map((t) => [t.userText, t.assistantText]), [["First question", "reply 1"]]);
});

test("a temporary chat writes no title or summary", async () => {
  const { helperCalls, chat } = await app();
  await chat("Hello", true);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(helperCalls, []);
});

test("a normal chat still saves, remembers and offers history", async () => {
  const { store, seen, helperCalls, chat } = await app();
  await chat("Hello there", false, "normal");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.turns.ofThread("normal").length, 1);
  assert.equal(typeof seen[0].searchHistory, "function");
  assert.match(seen[0].context, /Pune/);
  assert.deepEqual(helperCalls.sort(), ["summary", "title"]);
});

test("temporary chats are capped and expire when idle", () => {
  const chats = new TemporaryChats();
  const turn = (n: number) => ({ createdAt: n, userText: `q${n}`, assistantText: "a", sources: [], queries: [], status: "ok" as const });
  for (let i = 0; i < 45; i++) chats.add("t", turn(i), 0);
  assert.equal(chats.turns("t", 0).length, 40);
  assert.equal(chats.turns("t", 0)[0].userText, "q5");
  assert.equal(chats.turns("t", 61 * 60_000).length, 0);
});

test("Think more raises the effort for that message only", async () => {
  const { seen, base } = await app();
  const send = (thinkMore?: boolean) =>
    fetch(`${base}/api/chat`, { method: "POST", body: JSON.stringify({ threadId: "deep", message: "Hard question", thinkMore }) }).then((r) => r.text());
  await send(true);
  await send();
  assert.equal(seen[0].effort, "high");
  assert.equal(seen[1].effort, undefined);
});
