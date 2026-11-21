import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runGemini } from "../src/llm/providers/gemini.ts";
import { runOpenAI } from "../src/llm/providers/openai.ts";
import { MAX_EXTERNAL_CALLS, runFunctionCall } from "../src/llm/tools.ts";
import type { TurnOptions } from "../src/llm/types.ts";
import { MAX_TOOL_OUTPUT_CHARS, McpHub, readMcpConfig, type ToolClient } from "../src/mcp/hub.ts";

function fakeClient(reply: (name: string, args: unknown) => unknown = () => ({ content: [{ type: "text", text: "ok" }] })) {
  const calls: { name: string; arguments?: unknown }[] = [];
  let closed = false;
  const client: ToolClient = {
    listTools: async () => ({
      tools: [
        { name: "search_messages", description: "Search messages", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
        { name: "latest.briefing", inputSchema: { type: "object", properties: {} } },
      ],
    }),
    callTool: async (params) => {
      calls.push(params);
      return reply(params.name, params.arguments);
    },
    close: async () => {
      closed = true;
    },
  };
  return { client, calls, closed: () => closed };
}

const base = (extra: Partial<TurnOptions> = {}): TurnOptions & { model: string } => ({
  history: [],
  userText: "what did Priya say?",
  context: "Current time: now.",
  tz: "UTC",
  emit: () => {},
  model: "m",
  ...extra,
});

test("mcp.json is optional, and a broken one is reported instead of crashing", () => {
  const dir = mkdtempSync(join(tmpdir(), "mino-mcp-"));
  assert.deepEqual(readMcpConfig(join(dir, "missing.json")), { config: { mcpServers: {} } });

  writeFileSync(join(dir, "bad.json"), "{ nope");
  assert.match(readMcpConfig(join(dir, "bad.json")).warning!, /not valid JSON/);

  writeFileSync(join(dir, "shape.json"), JSON.stringify({ mcpServers: { "bad name!": { command: "x" } } }));
  assert.match(readMcpConfig(join(dir, "shape.json")).warning!, /mcpServers.bad name!/);

  writeFileSync(join(dir, "ok.json"), JSON.stringify({ mcpServers: { contextos: { command: "/bin/contextos", args: ["mcp"] } } }));
  assert.deepEqual(readMcpConfig(join(dir, "ok.json")).config.mcpServers.contextos, { command: "/bin/contextos", args: ["mcp"] });
});

test("the hub names tools by server, routes calls back, and closes its clients", async () => {
  const hub = new McpHub();
  const fake = fakeClient((name) => ({ content: [{ type: "text", text: `ran ${name}` }] }));
  assert.equal(await hub.add("contextos", fake.client), 2);
  assert.deepEqual(hub.tools().map((t) => t.name), ["contextos__search_messages", "contextos__latest_briefing"]);
  assert.match(hub.tools()[0].description, /^\[contextos\] Search messages/);

  assert.equal(await hub.call("contextos__search_messages", { query: "contract" }), "ran search_messages");
  assert.deepEqual(fake.calls[0], { name: "search_messages", arguments: { query: "contract" } });
  assert.equal(await hub.call("contextos__latest_briefing", "not an object"), "ran latest.briefing");
  assert.deepEqual(fake.calls[1].arguments, {});
  assert.match(await hub.call("nope__tool", {}), /no tool named/);

  await hub.close();
  assert.equal(fake.closed(), true);
});

test("tool errors and long output come back as text the model can read", async () => {
  const hub = new McpHub();
  const replies = [
    () => ({ isError: true, content: [{ type: "text", text: "bad date" }] }),
    () => {
      throw new Error("server went away");
    },
    () => ({ content: [{ type: "text", text: "x".repeat(MAX_TOOL_OUTPUT_CHARS + 50) }] }),
    () => ({ content: [{ type: "image" }] }),
  ];
  let i = 0;
  await hub.add("s", fakeClient(() => replies[i++]()).client);
  assert.match(await hub.call("s__search_messages", {}), /reported an error: bad date/);
  assert.match(await hub.call("s__search_messages", {}), /s tool failed: server went away/);
  assert.match(await hub.call("s__search_messages", {}), /\[cut at 12000 characters\]$/);
  assert.equal(await hub.call("s__search_messages", {}), "[image content omitted]");
});

test("connected tool calls are limited per reply, and unknown names are refused", async () => {
  let ran = 0;
  const options = base({
    tools: [{ name: "s__t", description: "", parameters: {} }],
    callTool: async () => `result ${++ran}`,
  });
  const count = { history: 0, external: 0 };
  for (let i = 0; i < MAX_EXTERNAL_CALLS; i++) assert.match(await runFunctionCall(options, "s__t", "{}", count), /^result/);
  assert.match(await runFunctionCall(options, "s__t", {}, count), /limit for this reply/);
  assert.match(await runFunctionCall(options, "other", {}, count), /no tool named other/);
  assert.equal(ran, MAX_EXTERNAL_CALLS);
});

test("Gemini declares connected tools and feeds their results back", async () => {
  const seen: any[] = [];
  let round = 0;
  const client = {
    models: {
      generateContentStream: async (p: any) => {
        seen.push(structuredClone({ tools: p.config.tools, contents: p.contents }));
        const r = round++;
        return (async function* () {
          if (r === 0) yield { candidates: [{ content: { parts: [{ functionCall: { id: "c1", name: "contextos__search_messages", args: { query: "contract" } } }] } }] };
          else yield { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Priya signed it." }] } }] };
        })();
      },
    },
  } as any;
  const calls: [string, unknown][] = [];
  const result = await runGemini({
    ...base(),
    client,
    tools: [{ name: "contextos__search_messages", description: "Search", parameters: { type: "object" } }],
    callTool: async (name, args) => {
      calls.push([name, args]);
      return "Priya: signed the contract";
    },
  });
  assert.equal(result.text, "Priya signed it.");
  assert.deepEqual(calls, [["contextos__search_messages", { query: "contract" }]]);
  assert.deepEqual(seen[0].tools[1].functionDeclarations.map((d: any) => d.name), ["contextos__search_messages"]);
  assert.deepEqual(seen[1].contents.at(-1).parts[0].functionResponse.response, { output: "Priya: signed the contract" });
});

test("OpenAI passes every function call through, not only history", async () => {
  let round = 0;
  let lastInput: any[] = [];
  const client = {
    responses: {
      stream: (p: any) => {
        lastInput = p.input;
        const r = round++;
        return (async function* () {
          if (r === 0) {
            yield { type: "response.completed", response: { status: "completed", output: [{ type: "function_call", call_id: "x", name: "contextos__latest_briefing", arguments: "{}" }] } };
          } else {
            yield { type: "response.output_text.delta", delta: "Two things need you." };
            yield { type: "response.completed", response: { status: "completed", output: [] } };
          }
        })();
      },
    },
  } as any;
  const result = await runOpenAI({
    ...base(),
    client,
    tools: [{ name: "contextos__latest_briefing", description: "Briefing", parameters: { type: "object" } }],
    callTool: async () => "Needs you: 2 items",
  });
  assert.equal(result.text, "Two things need you.");
  assert.deepEqual(lastInput.at(-1), { type: "function_call_output", call_id: "x", output: "Needs you: 2 items" });
});
