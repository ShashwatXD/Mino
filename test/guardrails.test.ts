import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ConfigError, loadConfig } from "../src/config/config.ts";
import { changedGuardrails, DEFAULT_GUARDRAILS, describeGuardrails, envName, GUARD, readGuardrails, setGuardrails } from "../src/config/guardrails.ts";
import { runGemini } from "../src/llm/providers/gemini.ts";
import { McpHub } from "../src/mcp/hub.ts";
import { fitHistory } from "../src/memory/history.ts";

afterEach(() => setGuardrails(DEFAULT_GUARDRAILS));

test("every limit has a default, an .env name and a reason", () => {
  const all = describeGuardrails();
  assert.ok(all.length >= 25);
  for (const g of all) {
    assert.ok(g.reason.length > 20, `${g.name} explains itself`);
    assert.match(g.env, /^[A-Z_]+$/);
  }
  assert.equal(envName("maxRounds"), "GUARD_MAX_ROUNDS");
  assert.equal(envName("historyChars"), "GUARD_HISTORY_CHARS");
  // The spending limits keep the names .env files already use.
  assert.equal(envName("dailyBudgetUsd"), "DAILY_BUDGET_USD");
  assert.equal(envName("maxPerMinute"), "MAX_MESSAGES_PER_MINUTE");
  assert.equal(new Set(all.map((g) => g.env)).size, all.length, "no two limits share a variable");
});

test(".env overrides a limit, and blank means default", () => {
  const { values, problems } = readGuardrails({ GUARD_MAX_ROUNDS: "3", GUARD_HISTORY_CHARS: " ", DAILY_BUDGET_USD: "0.25" });
  assert.deepEqual(problems, []);
  assert.equal(values.maxRounds, 3);
  assert.equal(values.historyChars, DEFAULT_GUARDRAILS.historyChars);
  assert.equal(values.dailyBudgetUsd, 0.25);
  assert.deepEqual(changedGuardrails(values), ["GUARD_MAX_ROUNDS=3 (default 6)", "DAILY_BUDGET_USD=0.25 (default 1)"]);
});

test("a bad value stops startup with the variable named", () => {
  const { problems } = readGuardrails({ GUARD_MAX_ROUNDS: "lots", GUARD_MAX_TOOL_CALLS: "2.5", GUARD_MAX_OUTPUT_TOKENS: "10" });
  assert.equal(problems.length, 3);
  assert.match(problems[0], /GUARD_MAX_ROUNDS: "lots" is not a number/);
  assert.match(problems[1], /GUARD_MAX_TOOL_CALLS: must be a whole number/);
  assert.match(problems[2], /GUARD_MAX_OUTPUT_TOKENS: must be between 256 and 64000/);
  assert.throws(() => loadConfig({ GUARD_MAX_ROUNDS: "0" }), (err: unknown) => err instanceof ConfigError && /GUARD_MAX_ROUNDS/.test(err.message));
});

test("loadConfig carries the guardrails, and the spending limits feed the spend guard", () => {
  const config = loadConfig({ GUARD_MAX_ROUNDS: "2", MAX_MESSAGES_PER_DAY: "50", GUARD_MAX_CONCURRENT: "1" });
  assert.equal(config.guardrails.maxRounds, 2);
  assert.deepEqual(config.limits, { dailyBudgetUsd: 1, maxPerMinute: 10, maxPerDay: 50, maxConcurrent: 1 });
});

test("GUARD_MAX_ROUNDS stops a model that keeps calling tools", async () => {
  setGuardrails({ maxRounds: 2 });
  let requests = 0;
  const client = {
    models: {
      generateContentStream: async () => {
        requests++;
        return (async function* () {
          yield { candidates: [{ content: { parts: [{ functionCall: { name: "s__t", args: {} } }] } }] };
        })();
      },
    },
  } as any;
  await runGemini({
    history: [], userText: "hi", context: "", tz: "UTC", emit: () => {}, model: "m", client,
    tools: [{ name: "s__t", description: "", parameters: {} }],
    callTool: async () => "again",
  });
  assert.equal(requests, 2);
});

test("GUARD_HISTORY_CHARS shrinks what the prompt keeps of a chat", () => {
  const turn = (id: number) => ({ id, threadId: "t", createdAt: id, userText: "q".repeat(40), assistantText: "a".repeat(60), sources: [], queries: [], status: "ok" as const });
  const turns = [1, 2, 3, 4, 5].map(turn);
  assert.equal(fitHistory(turns).length, 5);
  setGuardrails({ historyChars: 250 });
  assert.deepEqual(fitHistory(turns).map((t) => t.id), [4, 5], "the newest turns that fit, oldest dropped first");
});

test("GUARD_MAX_TOOL_RESULT_CHARS cuts connected tool output", async () => {
  setGuardrails({ maxToolResultChars: 500 });
  const hub = new McpHub();
  await hub.add("s", {
    listTools: async () => ({ tools: [{ name: "t", inputSchema: {} }] }),
    callTool: async () => ({ content: [{ type: "text", text: "x".repeat(900) }] }),
    close: async () => {},
  });
  const out = await hub.call("s__t", {});
  assert.match(out, /\[cut at 500 characters\]$/);
  assert.equal(GUARD.maxToolResultChars, 500);
});
