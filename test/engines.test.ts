import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatRequestSchema, ConfigError, loadConfig } from "../src/config/config.ts";
import { geminiContents, runGemini } from "../src/llm/providers/gemini.ts";
import { runOpenAI } from "../src/llm/providers/openai.ts";
import type { AgentEvent } from "../src/llm/types.ts";
import { friendlyError } from "../src/services/errors.ts";

const GEMINI = "AIzaSyA1234567890abcdefghijklmnopqrstuv";
const CLAUDE = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
const OPENAI = "sk-proj-abcdefghijklmnopqrstuvwxyz";

test("whichever key is present turns on that engine", () => {
  assert.equal(loadConfig({ GEMINI_API_KEY: GEMINI }).provider, "gemini");
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: CLAUDE }).provider, "anthropic");
  const openai = loadConfig({ OPENAI_API_KEY: OPENAI });
  assert.equal(openai.provider, "openai");
  assert.equal(openai.model, "gpt-6-luna");
});

test("Gemini is the default when several keys are present", () => {
  const config = loadConfig({ OPENAI_API_KEY: OPENAI, ANTHROPIC_API_KEY: CLAUDE, GEMINI_API_KEY: GEMINI });
  assert.equal(config.provider, "gemini");
  assert.equal(config.model, "gemini-3.1-flash-lite");
  assert.deepEqual(config.available, ["gemini", "anthropic", "openai"]);
});

test("PROVIDER picks among the keys, and falls back if its key is missing", () => {
  assert.equal(loadConfig({ PROVIDER: "openai", OPENAI_API_KEY: OPENAI, GEMINI_API_KEY: GEMINI }).provider, "openai");
  const fallback = loadConfig({ PROVIDER: "openai", GEMINI_API_KEY: GEMINI });
  assert.equal(fallback.provider, "gemini");
  assert.match(fallback.warnings[0], /no usable key/);
});

test("a key in the wrong variable still reaches the right engine", () => {
  const config = loadConfig({ GEMINI_API_KEY: CLAUDE });
  assert.equal(config.provider, "anthropic");
  assert.equal(config.apiKey, CLAUDE);
  assert.match(config.warnings[0], /key for anthropic/);
});

test("a generic API_KEY is identified from its prefix", () => {
  assert.equal(loadConfig({ API_KEY: OPENAI }).provider, "openai");
});

test("an invalid key is ignored without blocking a valid one", () => {
  const config = loadConfig({ GEMINI_API_KEY: "your_key_here_please_replace", OPENAI_API_KEY: OPENAI });
  assert.equal(config.provider, "openai");
  assert.match(config.warnings[0], /GEMINI_API_KEY was ignored/);
});

test("blank keys count as missing and the app still loads", () => {
  const config = loadConfig({ GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "   " });
  assert.equal(config.provider, null);
  assert.deepEqual(config.warnings, []);
});

test("a MODEL from another provider is not sent to the active engine", () => {
  const config = loadConfig({ GEMINI_API_KEY: GEMINI, MODEL: "claude-opus-5-5" });
  assert.equal(config.model, "gemini-3.1-flash-lite");
  assert.match(config.warnings[0], /does not belong/);
  assert.equal(loadConfig({ GEMINI_API_KEY: GEMINI, MODEL: "gemini-3.6-flash" }).model, "gemini-3.6-flash");
});

test("invalid settings fail with a clear error", () => {
  assert.throws(() => loadConfig({ PORT: "abc" }), ConfigError);
  assert.throws(() => loadConfig({ PROVIDER: "llama" }), ConfigError);
});

test("chat requests are validated", () => {
  assert.equal(ChatRequestSchema.safeParse({ message: "  hi " }).data?.message, "hi");
  assert.equal(ChatRequestSchema.safeParse({ message: "   " }).success, false);
  assert.equal(ChatRequestSchema.safeParse({ message: 5 }).success, false);
  assert.equal(ChatRequestSchema.safeParse({ message: "x".repeat(20001) }).success, false);
});

test("errors are mapped the same way for every engine", () => {
  assert.match(friendlyError(Object.assign(new Error("x"), { status: 401 })), /rejected/);
  assert.match(friendlyError(Object.assign(new Error("API key not valid"), { status: 400 })), /rejected/);
  assert.match(friendlyError(Object.assign(new Error("x"), { status: 429 })), /rate limited/);
  assert.match(friendlyError(Object.assign(new Error("x"), { status: 402 })), /no credits/);
  assert.match(friendlyError(new TypeError("fetch failed")), /reach the model/);
});

const options = (emit: (e: AgentEvent) => void) => ({
  history: [
    { id: 1, threadId: "t", createdAt: Date.UTC(2026, 10, 3), userText: "q", assistantText: "a", sources: [], queries: [], status: "ok" as const },
  ],
  userText: "hello",
  context: "Current time: now.",
  tz: "UTC",
  emit,
  model: "m",
});

test("Gemini keeps history first and the changing context last", () => {
  const contents = geminiContents(options(() => {}));
  assert.deepEqual(contents.map((c) => c.role), ["user", "model", "user"]);
  assert.match(contents[0].parts![0].text!, /3 Nov 2026/);
  assert.equal(contents[2].parts!.length, 1);
  assert.match(contents[2].parts![0].text!, /<application_context>\nCurrent time[\s\S]*<\/application_context>\n\n<user_message>\nhello\n<\/user_message>/);
});

test("Gemini streams text and reads grounding into sources", async () => {
  const events: AgentEvent[] = [];
  let params: any;
  const client = {
    models: {
      generateContentStream: async (p: any) => {
        params = p;
        return (async function* () {
          yield { candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: "Neon " }] } }] };
          yield {
            candidates: [
              {
                finishReason: "STOP",
                content: { parts: [{ text: "is $19." }] },
                groundingMetadata: {
                  webSearchQueries: ["neon pricing"],
                  groundingChunks: [{ web: { uri: "https://r/1", title: "neon.tech" } }, { web: { uri: "https://r/2", title: "other.com" } }],
                  groundingSupports: [{ groundingChunkIndices: [0] }],
                },
              },
            ],
          };
        })();
      },
    },
  } as any;
  const result = await runGemini({ ...options((e) => events.push(e)), client });
  assert.equal(result.text, "Neon is $19.");
  assert.deepEqual(result.queries, ["neon pricing"]);
  assert.deepEqual(result.sources[0], { url: "https://r/1", title: "neon.tech", cited: true });
  assert.equal(result.sources[1].cited, false);
  assert.deepEqual(params.config.tools, [{ googleSearch: {} }]);
});

test("a blocked Gemini reply still gives the user an answer", async () => {
  const client = {
    models: {
      generateContentStream: async () =>
        (async function* () {
          yield { candidates: [{ finishReason: "SAFETY" }] };
        })(),
    },
  } as any;
  const result = await runGemini({ ...options(() => {}), client });
  assert.match(result.text, /can't help/);
});

test("OpenAI streams text and collects searches and citations", async () => {
  let params: any;
  const client = {
    responses: {
      stream: (p: any) => {
        params = p;
        return (async function* () {
          yield { type: "response.web_search_call.searching" };
          yield { type: "response.output_item.done", item: { type: "web_search_call", action: { type: "search", queries: ["neon pricing"] } } };
          yield { type: "response.output_text.delta", delta: "Neon is $19." };
          yield { type: "response.output_text.annotation.added", annotation: { type: "url_citation", url: "https://neon.tech/pricing", title: "Neon" } };
          yield { type: "response.completed", response: { status: "completed" } };
        })();
      },
    },
  } as any;
  const result = await runOpenAI({ ...options(() => {}), client });
  assert.equal(result.text, "Neon is $19.");
  assert.deepEqual(result.queries, ["neon pricing"]);
  assert.equal(result.sources[0].cited, true);
  assert.equal(params.input.at(-1).role, "developer");
  assert.deepEqual(params.tools, [{ type: "web_search" }]);
});

test("a failed OpenAI response raises instead of saving an empty answer", async () => {
  const client = {
    responses: {
      stream: () =>
        (async function* () {
          yield { type: "response.failed", response: { error: { message: "boom" } } };
        })(),
    },
  } as any;
  await assert.rejects(runOpenAI({ ...options(() => {}), client }), /boom/);
});
