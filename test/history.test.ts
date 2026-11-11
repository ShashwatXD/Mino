import assert from "node:assert/strict";
import { test } from "node:test";
import { createRepositories } from "../src/db/repositories/index.ts";
import type { HistoryQuery } from "../src/domain/turn.ts";
import { runTurn } from "../src/llm/providers/anthropic.ts";
import { runGemini } from "../src/llm/providers/gemini.ts";
import { runOpenAI } from "../src/llm/providers/openai.ts";
import { EMPTY_TEXT } from "../src/llm/prompt.ts";
import { MAX_HISTORY_CALLS } from "../src/llm/tools.ts";
import type { TurnOptions } from "../src/llm/types.ts";
import { searchHistory } from "../src/memory/search.ts";

const TZ = "Asia/Kolkata";
const NOV3 = Date.UTC(2026, 10, 3, 6, 30);
const NOV9 = Date.UTC(2026, 10, 9, 6, 30);

function seeded() {
  const store = createRepositories(":memory:");
  const add = (at: number, userText: string, assistantText: string) =>
    store.turns.save({ threadId: "old", createdAt: at, userText, assistantText, sources: [], queries: [], status: "ok" });
  add(NOV3, "Pizza dough recipe", "Use 65% hydration");
  add(NOV9, "Shortlist CRM tools for a sales team", "HubSpot, Pipedrive, Zoho");
  return store;
}

test("history search finds a day by its date range", () => {
  const result = searchHistory(seeded().turns, { from: "2026-11-03", to: "2026-11-03" }, TZ);
  assert.match(result, /Pizza dough recipe/);
  assert.doesNotMatch(result, /CRM/);
  assert.match(result, /3 Nov 2026/);
});

test("history search finds a topic despite a typo", () => {
  const result = searchHistory(seeded().turns, { query: "crm toolz" }, TZ);
  assert.match(result, /HubSpot/);
  assert.doesNotMatch(result, /Pizza/);
});

test("history search says plainly when nothing is on record", () => {
  const result = searchHistory(seeded().turns, { query: "postgres", from: "2026-11-02", to: "2026-11-02" }, TZ);
  assert.match(result, /^No past conversations found on Mon, 2 Nov 2026, about "postgres"/);
});

test("history search rejects an impossible range instead of guessing", () => {
  assert.match(searchHistory(seeded().turns, { from: "2026-11-09", to: "2026-11-01" }, TZ), /not valid/);
});

// Each fake engine first asks for history, then answers with what it got.
const engines = {
  gemini(answer = true) {
    const requests: any[] = [];
    const client = {
      models: {
        generateContentStream: async (params: any) => {
          requests.push(structuredClone({ ...params, config: { ...params.config, abortSignal: undefined } }));
          const first = requests.length === 1 || !answer;
          const parts = first
            ? [{ thoughtSignature: "sig-1", functionCall: { id: `c${requests.length}`, name: "search_history", args: { from: "2026-11-03", to: "2026-11-03" } } }]
            : [{ text: "On 3 Nov you asked for a pizza dough recipe." }];
          return (async function* () {
            yield { candidates: [{ finishReason: "STOP", content: { role: "model", parts } }] };
          })();
        },
      },
    } as any;
    return { requests, run: (options: TurnOptions) => runGemini({ ...options, client, model: "m" }) };
  },
  claude(answer = true) {
    const requests: any[] = [];
    const client = {
      beta: {
        messages: {
          stream: (params: any) => {
            requests.push(structuredClone(params));
            const first = requests.length === 1 || !answer;
            const content = first
              ? [{ type: "thinking", thinking: "Check the log.", signature: "sig-1" }, { type: "tool_use", id: `t${requests.length}`, name: "search_history", input: { from: "2026-11-03", to: "2026-11-03" } }]
              : [{ type: "text", text: "On 3 Nov you asked for a pizza dough recipe." }];
            return {
              async *[Symbol.asyncIterator]() {
                if (!first) yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "On 3 Nov you asked for a pizza dough recipe." } };
              },
              finalMessage: async () => ({ stop_reason: first ? "tool_use" : "end_turn", content, usage: { input_tokens: 10, output_tokens: 5 } }),
            };
          },
        },
      },
    } as any;
    return { requests, run: (options: TurnOptions) => runTurn({ ...options, client, model: "m", effort: "medium" }) };
  },
  openai(answer = true) {
    const requests: any[] = [];
    const client = {
      responses: {
        stream: (params: any) => {
          requests.push(structuredClone(params));
          const first = requests.length === 1 || !answer;
          return (async function* () {
            if (!first) yield { type: "response.output_text.delta", delta: "On 3 Nov you asked for a pizza dough recipe." };
            const output = first
              ? [{ type: "reasoning", id: `r${requests.length}` }, { type: "function_call", call_id: `f${requests.length}`, name: "search_history", arguments: '{"from":"2026-11-03","to":"2026-11-03"}' }]
              : [];
            yield { type: "response.completed", response: { status: "completed", output, usage: { input_tokens: 10, output_tokens: 5 } } };
          })();
        },
      },
    } as any;
    return { requests, run: (options: TurnOptions) => runOpenAI({ ...options, client, model: "m" }) };
  },
};

const options = (searched: HistoryQuery[]): TurnOptions => ({
  history: [],
  userText: "What did I ask on 3 November?",
  context: "Current time: now.",
  tz: TZ,
  emit: () => {},
  searchHistory: (query) => (searched.push(query), searchHistory(seeded().turns, query, TZ)),
});

for (const [name, make] of Object.entries(engines)) {
  test(`${name}: offers web search and history, runs the lookup, and answers from it`, async () => {
    const engine = make();
    const searched: HistoryQuery[] = [];
    const result = await engine.run(options(searched));
    assert.equal(result.text, "On 3 Nov you asked for a pizza dough recipe.");
    assert.deepEqual(searched, [{ query: undefined, pattern: undefined, from: "2026-11-03", to: "2026-11-03", chatId: undefined, page: undefined }]);
    assert.equal(engine.requests.length, 2);
    assert.match(JSON.stringify(engine.requests[0]), /search_history/);
    const second = JSON.stringify(engine.requests[1]);
    assert.match(second, /Pizza dough recipe/, "the lookup result reaches the model");
    assert.match(second, /sig-1|r1/, "the model's own turn goes back unchanged");
  });

  test(`${name}: a model that keeps searching is stopped`, async () => {
    const engine = make(false);
    const searched: HistoryQuery[] = [];
    const result = await engine.run(options(searched));
    assert.equal(searched.length, MAX_HISTORY_CALLS);
    assert.ok(engine.requests.length <= MAX_HISTORY_CALLS + 2);
    assert.match(JSON.stringify(engine.requests.at(-1)), /limit for this reply is reached/);
    assert.equal(result.text, EMPTY_TEXT);
  });

  test(`${name}: without a history store, only web search is offered`, async () => {
    const engine = make();
    await engine.run({ ...options([]), searchHistory: undefined }).catch(() => {});
    assert.doesNotMatch(JSON.stringify(engine.requests[0]), /search_history"/);
  });
}

test("a per-message effort reaches Gemini's thinking level", async () => {
  const engine = engines.gemini();
  await engine.run({ ...options([]), searchHistory: undefined, effort: "high" });
  assert.equal(engine.requests[0].config.thinkingConfig.thinkingLevel, "HIGH");
});
