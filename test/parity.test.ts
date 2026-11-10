import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn } from "../src/llm/providers/anthropic.ts";
import { runGemini } from "../src/llm/providers/gemini.ts";
import { runOpenAI } from "../src/llm/providers/openai.ts";
import { EMPTY_TEXT, MAX_OUTPUT_TOKENS } from "../src/llm/prompt.ts";
import { type AgentEvent, type TurnOptions } from "../src/llm/types.ts";

const URL = "https://neon.tech/pricing";
const usage = { input: 100, output: 20 };

interface Reply {
  text?: string;
  search?: string;
}

const anthropic = {
  name: "claude",
  run(options: TurnOptions, reply: Reply) {
    const seen: any = {};
    const events: unknown[] = [];
    if (reply.search) {
      events.push(
        { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", name: "web_search" } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: reply.search }) } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", content: [{ type: "web_search_result", url: URL, title: "Neon" }] } },
      );
    }
    if (reply.text) {
      events.push({ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: reply.text } });
      if (reply.search) events.push({ type: "content_block_delta", index: 2, delta: { type: "citations_delta", citation: { url: URL, title: "Neon" } } });
    }
    const client = {
      beta: {
        messages: {
          stream: (params: any, request: any) => {
            seen.params = params;
            seen.signal = request?.signal;
            return {
              async *[Symbol.asyncIterator]() {
                yield* events;
              },
              finalMessage: async () => ({
                stop_reason: "end_turn",
                content: [],
                usage: { input_tokens: usage.input, output_tokens: usage.output, server_tool_use: { web_search_requests: reply.search ? 1 : 0 } },
              }),
            };
          },
        },
      },
    } as any;
    return { seen, result: runTurn({ ...options, client, model: "m", effort: "medium" }) };
  },
  prompt: (seen: any) => {
    const last = seen.params.messages.at(-1);
    return { context: last.content as string, user: seen.params.messages.at(-2).content as string, history: seen.params.messages.slice(0, -2) };
  },
  historyText: (m: any) => (typeof m.content === "string" ? m.content : m.content[0].text),
  tools: (seen: any) => seen.params.tools.map((t: any) => t.name),
  outputCap: (seen: any) => seen.params.max_tokens,
  searchCap: (seen: any) => seen.params.tools[0].max_uses,
  signal: (seen: any) => seen.signal,
};

const gemini = {
  name: "gemini",
  run(options: TurnOptions, reply: Reply) {
    const seen: any = {};
    const client = {
      models: {
        generateContentStream: async (params: any) => {
          seen.params = params;
          return (async function* () {
            yield {
              usageMetadata: { promptTokenCount: usage.input, candidatesTokenCount: usage.output },
              candidates: [
                {
                  finishReason: "STOP",
                  content: { parts: reply.text ? [{ text: reply.text }] : [] },
                  ...(reply.search
                    ? {
                        groundingMetadata: {
                          webSearchQueries: [reply.search],
                          groundingChunks: [{ web: { uri: URL, title: "Neon" } }],
                          groundingSupports: [{ groundingChunkIndices: [0] }],
                        },
                      }
                    : {}),
                },
              ],
            };
          })();
        },
      },
    } as any;
    return { seen, result: runGemini({ ...options, client, model: "m" }) };
  },
  prompt: (seen: any) => {
    const text: string = seen.params.contents.at(-1).parts[0].text;
    return { context: text, user: text, history: seen.params.contents.slice(0, -1) };
  },
  historyText: (m: any) => m.parts[0].text,
  tools: (seen: any) => seen.params.config.tools.map((t: any) => Object.keys(t)[0]),
  outputCap: (seen: any) => seen.params.config.maxOutputTokens,
  searchCap: () => undefined,
  signal: (seen: any) => seen.params.config.abortSignal,
};

const openai = {
  name: "openai",
  run(options: TurnOptions, reply: Reply) {
    const seen: any = {};
    const client = {
      responses: {
        stream: (params: any, request: any) => {
          seen.params = params;
          seen.signal = request?.signal;
          return (async function* () {
            if (reply.search) yield { type: "response.output_item.done", item: { type: "web_search_call", action: { type: "search", queries: [reply.search] } } };
            if (reply.text) yield { type: "response.output_text.delta", delta: reply.text };
            if (reply.search) yield { type: "response.output_text.annotation.added", annotation: { type: "url_citation", url: URL, title: "Neon" } };
            yield { type: "response.completed", response: { status: "completed", usage: { input_tokens: usage.input, output_tokens: usage.output } } };
          })();
        },
      },
    } as any;
    return { seen, result: runOpenAI({ ...options, client, model: "m" }) };
  },
  prompt: (seen: any) => {
    const last = seen.params.input.at(-1);
    return { context: last.content as string, user: seen.params.input.at(-2).content as string, history: seen.params.input.slice(0, -2) };
  },
  historyText: (m: any) => m.content,
  tools: (seen: any) => seen.params.tools.map((t: any) => t.type),
  outputCap: (seen: any) => seen.params.max_output_tokens,
  searchCap: (seen: any) => seen.params.max_tool_calls,
  signal: (seen: any) => seen.signal,
};

const engines = [anthropic, gemini, openai];

const options = (extra: Partial<TurnOptions> = {}): TurnOptions => ({
  history: [
    { id: 1, threadId: "t", createdAt: Date.UTC(2026, 10, 3), userText: "Old question", assistantText: "Old answer", sources: [], queries: [], status: "ok" },
    { id: 2, threadId: "t", createdAt: Date.UTC(2026, 10, 4), userText: "Second question", assistantText: "Second answer", sources: [], queries: [], status: "ok" },
  ],
  userText: "Has pricing changed?",
  context: "Current time: now.\nThe log below is what was said.",
  tz: "UTC",
  emit: () => {},
  ...extra,
});

for (const engine of engines) {
  test(`${engine.name}: gives the model exactly one tool, web search`, async () => {
    const { seen, result } = engine.run(options(), { text: "ok" });
    await result;
    const tools = engine.tools(seen);
    assert.equal(tools.length, 1);
    assert.match(tools[0], /web_?search|googleSearch/i);
  });

  test(`${engine.name}: the model sees the message and the context, kept apart`, async () => {
    const { seen, result } = engine.run(options(), { text: "ok" });
    await result;
    const { context, user } = engine.prompt(seen);
    assert.match(context, /Current time: now\./);
    assert.match(context, /The log below is what was said\./);
    assert.match(user, /Has pricing changed\?/);
    assert.doesNotMatch(user, /changed\?(Current|The log)/);
  });

  test(`${engine.name}: replays history oldest first with real dates`, async () => {
    const { seen, result } = engine.run(options(), { text: "ok" });
    await result;
    const { history } = engine.prompt(seen);
    const texts = history.map(engine.historyText);
    assert.equal(texts.length, 4);
    assert.match(texts[0], /3 Nov 2026.*Old question/);
    assert.equal(texts[1], "Old answer");
    assert.match(texts[2], /4 Nov 2026.*Second question/);
  });

  test(`${engine.name}: caps output and can be stopped`, async () => {
    const stop = new AbortController();
    const { seen, result } = engine.run(options({ signal: stop.signal }), { text: "ok" });
    await result;
    assert.equal(engine.outputCap(seen), MAX_OUTPUT_TOKENS);
    assert.equal(engine.signal(seen), stop.signal);
  });

  test(`${engine.name}: passes on the search cap where the provider offers one`, async () => {
    const { seen, result } = engine.run(options({ maxSearches: 8 }), { text: "ok" });
    await result;
    assert.equal(engine.searchCap(seen), engine.name === "gemini" ? undefined : 8);
  });

  test(`${engine.name}: an empty reply still tells the user something`, async () => {
    const shown: AgentEvent[] = [];
    const { result } = engine.run(options({ emit: (e) => shown.push(e) }), {});
    assert.equal((await result).text, EMPTY_TEXT);
    assert.ok(shown.some((e) => e.type === "text"));
  });
}

test("every engine turns the same reply into the same result", async () => {
  const outcomes = [];
  for (const engine of engines) {
    const shown: AgentEvent[] = [];
    const { result } = engine.run(options({ emit: (e) => shown.push(e) }), { text: "Neon is $19.", search: "neon pricing" });
    const r = await result;
    outcomes.push({
      text: r.text,
      queries: r.queries,
      sources: r.sources.map((s) => ({ url: s.url, cited: s.cited })),
      usage: { input: r.usage?.inputTokens, output: r.usage?.outputTokens, searches: r.usage?.searches },
      events: shown.map((e) => e.type).sort(),
    });
  }
  assert.deepEqual(outcomes[1], outcomes[0], "gemini differs from claude");
  assert.deepEqual(outcomes[2], outcomes[0], "openai differs from claude");
  assert.deepEqual(outcomes[0].usage, { input: 100, output: 20, searches: 1 });
});
