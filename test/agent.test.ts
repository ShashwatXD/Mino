import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn } from "../src/llm/providers/anthropic.ts";
import type { AgentEvent } from "../src/llm/types.ts";

const TZ = "Asia/Kolkata";
const NOW = Date.UTC(2026, 10, 10, 6, 30);
function fakeClient(turns: { events: unknown[]; stop: string; content?: unknown[] }[]) {
  const calls: any[] = [];
  return {
    calls,
    client: {
      beta: {
        messages: {
          stream(params: any) {
            calls.push(structuredClone(params));
            const turn = turns.shift()!;
            return {
              async *[Symbol.asyncIterator]() {
                yield* turn.events;
              },
              finalMessage: async () => ({ stop_reason: turn.stop, content: turn.content ?? [] }),
            };
          },
        },
      },
    } as any,
  };
}

const run = (client: any, extra = {}) => {
  const events: AgentEvent[] = [];
  return runTurn({
    client,
    model: "m",
    effort: "medium",
    history: [],
    userText: "hi",
    context: "Current time: now.",
    tz: TZ,
    emit: (e) => events.push(e),
    ...extra,
  }).then((result) => ({ result, events }));
};

test("streams text, reports searches, and collects cited sources", async () => {
  const { client } = fakeClient([
    {
      stop: "end_turn",
      events: [
        { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", name: "web_search" } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"neon pricing"}' } },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "web_search_tool_result",
            content: [{ type: "web_search_result", url: "https://neon.tech/pricing", title: "Neon", page_age: "2 days" }],
          },
        },
        { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Neon is $19." } },
        { type: "content_block_delta", index: 2, delta: { type: "citations_delta", citation: { url: "https://neon.tech/pricing", title: "Neon" } } },
      ],
    },
  ]);
  const { result, events } = await run(client);
  assert.equal(result.text, "Neon is $19.");
  assert.deepEqual(result.queries, ["neon pricing"]);
  assert.deepEqual(result.sources, [{ url: "https://neon.tech/pricing", title: "Neon", pageAge: "2 days", cited: true }]);
  assert.ok(events.some((e) => e.type === "search"));
});

test("resumes a paused server turn without adding a user message", async () => {
  const paused = [{ type: "server_tool_use", id: "x" }];
  const { client, calls } = fakeClient([
    { stop: "pause_turn", events: [], content: paused },
    { stop: "end_turn", events: [{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done" } }] },
  ]);
  const { result } = await run(client);
  assert.equal(result.text, "Done");
  assert.equal(calls.length, 2);
  const last = calls[1].messages.at(-1);
  assert.equal(last.role, "assistant");
  assert.deepEqual(last.content, paused);
});

test("a failed search does not crash the turn", async () => {
  const { client } = fakeClient([
    {
      stop: "end_turn",
      events: [
        { type: "content_block_start", index: 0, content_block: { type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "unavailable" } } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "I could not verify that." } },
      ],
    },
  ]);
  const { result } = await run(client);
  assert.equal(result.text, "I could not verify that.");
  assert.deepEqual(result.sources, []);
});

test("the context goes last so history stays a cacheable prefix", async () => {
  const { client, calls } = fakeClient([{ stop: "end_turn", events: [] }]);
  const history = [
    { id: 1, threadId: "t", createdAt: NOW - 1000, userText: "q", assistantText: "a", sources: [], queries: [], status: "ok" as const },
  ];
  await run(client, { history });
  const roles = calls[0].messages.map((m: any) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "user", "system"]);
  assert.deepEqual(calls[0].messages[1].content[0].cache_control, { type: "ephemeral" });
  assert.match(calls[0].messages[0].content, /10 Nov 2026/);
});

test("a refusal gives the user a reply instead of silence", async () => {
  const { client } = fakeClient([{ stop: "refusal", events: [] }]);
  const { result } = await run(client);
  assert.ok(result.text.length > 0);
});
