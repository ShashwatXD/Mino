import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { createRepositories } from "../src/db/repositories/index.ts";
import type { Trace } from "../src/domain/trace.ts";
import { createApp } from "../src/http/app.ts";
import { type LlmCallRecord, readableMessages, snapshot } from "../src/llm/call-record.ts";
import { runGemini } from "../src/llm/providers/gemini.ts";
import type { TurnOptions } from "../src/llm/types.ts";

const servers: Server[] = [];
after(() => servers.forEach((s) => (s.closeAllConnections(), s.close())));

const usage = { model: "gemini-3.1-flash-lite", inputTokens: 50, outputTokens: 5, searches: 0 };
const smallRecord = (purpose: LlmCallRecord["purpose"]): LlmCallRecord => ({
  purpose,
  provider: "gemini",
  model: usage.model,
  startedAt: performance.now(),
  durationMs: 3,
  request: { system: `${purpose} instructions`, messages: [{ role: "user", content: "First message:\nhi" }], tools: [], settings: {} },
  response: { text: "A title", thoughts: "", toolCalls: [], stopReason: null, webQueries: [], sources: [] },
  usage,
  raw: { request: {}, response: {} },
});

test("every Gemini round is recorded with its request, thinking, tool calls and usage", async () => {
  let round = 0;
  const client = {
    models: {
      generateContentStream: async () => {
        const r = round++;
        return (async function* () {
          if (r === 0) {
            yield {
              usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 10, thoughtsTokenCount: 40 },
              candidates: [{ content: { parts: [{ text: "Name, so check their messages.", thought: true }, { functionCall: { name: "contextos__search_messages", args: { query: "Shashwat" } }, thoughtSignature: "x".repeat(500) }] } }],
            };
          } else {
            yield { usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 30 }, candidates: [{ finishReason: "STOP", content: { parts: [{ text: "That's you." }] } }] };
          }
        })();
      },
    },
  } as any;
  const records: LlmCallRecord[] = [];
  const result = await runGemini({
    history: [],
    userText: "do you know shashwat?",
    context: "Current time: now.",
    tz: "UTC",
    emit: () => {},
    model: "gemini-3.8-flash",
    client,
    tools: [{ name: "contextos__search_messages", description: "Search", parameters: { type: "object" } }],
    callTool: async () => "slack · #social · 2 messages",
    onLlmCall: (r) => records.push(r),
  });

  assert.equal(result.text, "That's you.");
  assert.deepEqual(records.map((r) => r.round), [1, 2]);
  const [first, second] = records;
  assert.equal(first.response.thoughts, "Name, so check their messages.");
  assert.deepEqual(first.response.toolCalls, [{ name: "contextos__search_messages", args: { query: "Shashwat" } }]);
  assert.equal(first.response.text, "");
  assert.deepEqual([first.usage.inputTokens, first.usage.outputTokens, first.usage.thinkingTokens], [900, 50, 40]);
  assert.deepEqual(first.request.tools.map((t) => t.name), ["google_search (built-in)", "contextos__search_messages"]);
  assert.match(first.request.messages.at(-1)!.content, /do you know shashwat/);
  // Round 2 sees what round 1 asked for and what the tool returned, in order.
  assert.equal(second.request.messages.length, 3);
  assert.match(second.request.messages[1].content, /→ calls contextos__search_messages\({"query":"Shashwat"}\)/);
  assert.match(second.request.messages[2].content, /← result of contextos__search_messages:\nslack · #social/);
  assert.equal(second.response.text, "That's you.");
  assert.equal(second.response.stopReason, "STOP");
  // Snapshots were taken when sent, and opaque signatures are shortened.
  assert.equal((first.raw.request as any).contents.length, 1);
  assert.match(JSON.stringify(second.raw.request), /\[thoughtSignature, 500 chars\]/);
});

test("a failed round is still recorded, with its error", async () => {
  const records: LlmCallRecord[] = [];
  const client = { models: { generateContentStream: async () => Promise.reject(new Error("403 billing")) } } as any;
  await assert.rejects(runGemini({ history: [], userText: "hi", context: "", tz: "UTC", emit: () => {}, model: "m", client, onLlmCall: (r) => records.push(r) }), /403/);
  assert.equal(records.length, 1);
  assert.equal(records[0].error, "403 billing");
});

test("readable messages cover every engine's shapes", () => {
  assert.deepEqual(readableMessages([{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "found" }] }]), [{ role: "user", content: "← result for t1:\nfound" }]);
  assert.deepEqual(readableMessages([{ type: "function_call", name: "a__b", arguments: "{}" }]), [{ role: "assistant", content: "→ calls a__b({})" }]);
  assert.deepEqual(readableMessages([{ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] }]), [{ role: "assistant", content: "[thinking]\nhmm" }]);
  assert.equal((snapshot({ a: "x".repeat(70_000) }) as any).a.length < 70_000, true);
});

test("a trace counts model and tool calls and keeps their full details, summary included", async () => {
  const store = createRepositories(":memory:");
  const run = async (options: TurnOptions) => {
    const started = performance.now();
    options.onLlmCall!({ ...smallRecord("answer"), round: 1, startedAt: started, response: { ...smallRecord("answer").response, text: "", toolCalls: [{ name: "contextos__search_messages", args: { query: "x" } }] } });
    await options.callTool!("contextos__search_messages", { query: "x" });
    options.onLlmCall!({ ...smallRecord("answer"), round: 2, startedAt: performance.now() });
    options.emit({ type: "text", text: "Done." });
    return { text: "Done.", sources: [], queries: [], stopReason: "STOP", usage: { model: "gemini-3.8-flash", inputTokens: 100, outputTokens: 10, searches: 0 } };
  };
  const server = createServer(
    createApp({
      store,
      run,
      currentModel: () => "gemini-3.8-flash",
      tools: { list: () => [{ name: "contextos__search_messages", description: "", parameters: {} }], call: async () => "two messages\nmore lines" },
      helpers: () => ({
        title: async () => ({ text: "Title", usage, record: smallRecord("title") }),
        summarize: async () => ({ text: "Summary", usage, record: smallRecord("summary") }),
      }),
    }),
  );
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await (await fetch(`${base}/api/chat`, { method: "POST", body: JSON.stringify({ threadId: "t", message: "hi" }) })).text();

  // The summary finishes after the reply and is added to the saved trace.
  let trace: Trace | undefined;
  for (let i = 0; i < 50 && !trace?.spans.some((s) => s.name === "llm · summary"); i++) {
    await new Promise((r) => setTimeout(r, 10));
    trace = store.traces.ofThread("t")[0];
  }
  assert.ok(trace);
  assert.equal(store.traces.list().length, 1);
  assert.equal(trace.llmCalls, 4);
  assert.equal(trace.toolCalls, 1);
  const names = trace.spans.map((s) => s.name);
  for (const name of ["build_prompt", "llm · title", "llm · round 1", "contextos__search_messages", "llm · round 2", "llm · summary", "model"]) assert.ok(names.includes(name), name);
  assert.equal(trace.spans.find((s) => s.name === "model")!.attributes.rounds, 2);
  assert.equal(trace.spans.find((s) => s.name === "llm · round 1")!.attributes.asked_for, "contextos__search_messages");
  const tool = trace.spans.find((s) => s.name === "contextos__search_messages")!.detail as any;
  assert.deepEqual([tool.server, tool.tool, tool.arguments, tool.result], ["contextos", "search_messages", { query: "x" }, "two messages\nmore lines"]);
  const prompt = trace.spans.find((s) => s.name === "build_prompt")!.detail as any;
  assert.equal(prompt.kind, "prompt");
  assert.match(prompt.context, /Current time/);
  assert.equal((trace.spans.find((s) => s.name === "llm · title")!.detail as any).request.system, "title instructions");
});
