import { existsSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { GUARD } from "../config/guardrails.ts";
import type { ExternalTool } from "../llm/types.ts";

/** Same shape as Claude's and Cursor's mcp.json, so a server entry can be copied across unchanged. */
const ConfigSchema = z.object({
  mcpServers: z.record(
    z.string().regex(/^[A-Za-z0-9_-]{1,24}$/, "server names may use letters, digits, _ and - (up to 24)"),
    z.object({
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      env: z.record(z.string(), z.string()).optional(),
      cwd: z.string().optional(),
    }),
  ),
});
export type McpConfig = z.infer<typeof ConfigSchema>;


/** The slice of an MCP client the hub uses, so tests can pass a fake. */
export interface ToolClient {
  listTools(): Promise<{ tools: { name: string; description?: string; inputSchema: unknown }[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }, schema?: undefined, options?: { timeout?: number; signal?: AbortSignal }): Promise<unknown>;
  close(): Promise<void>;
}

interface Route {
  server: string;
  tool: string;
  client: ToolClient;
}

/** Reads mcp.json. A missing file means no servers; a broken one is reported and ignored. */
export function readMcpConfig(path: string): { config: McpConfig; warning?: string } {
  const empty = { mcpServers: {} };
  if (!existsSync(path)) return { config: empty };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { config: empty, warning: `mcp.json was ignored: it is not valid JSON (${(err as Error).message}).` };
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { config: empty, warning: `mcp.json was ignored. ${problems}` };
  }
  return { config: parsed.data };
}

/**
 * Connects to MCP servers and offers their tools to the model as `<server>__<tool>`.
 * A server that fails to start is skipped with a warning, so Mino still runs without it.
 */
export class McpHub {
  private readonly routes = new Map<string, Route>();
  private readonly clients: ToolClient[] = [];
  private offered: ExternalTool[] = [];

  /** Adds one connected server's tools. Exposed apart from connectAll so tests can use fakes. */
  async add(server: string, client: ToolClient): Promise<number> {
    this.clients.push(client);
    const { tools } = await client.listTools();
    let added = 0;
    for (const tool of tools) {
      // Provider tool names allow [A-Za-z0-9_-] up to 64 characters.
      const name = `${server}__${tool.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
      if (this.routes.has(name)) continue;
      this.routes.set(name, { server, tool: tool.name, client });
      this.offered.push({
        name,
        description: `[${server}] ${tool.description ?? tool.name}`.slice(0, 1024),
        parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
      });
      added++;
    }
    return added;
  }

  async connectAll(config: McpConfig, log: (line: string) => void = console.log): Promise<void> {
    await Promise.all(
      Object.entries(config.mcpServers).map(async ([server, spec]) => {
        const transport = new StdioClientTransport({
          command: spec.command,
          args: spec.args,
          env: { ...getDefaultEnvironment(), ...spec.env },
          cwd: spec.cwd,
          stderr: "ignore",
        });
        const client = new Client({ name: "mino", version: "1.0.0" });
        try {
          await client.connect(transport, { timeout: GUARD.mcpConnectTimeoutMs });
          const count = await this.add(server, client as unknown as ToolClient);
          log(`MCP: ${server} connected (${count} tools)`);
        } catch (err) {
          await client.close().catch(() => {});
          log(`MCP: ${server} could not start and was skipped: ${(err as Error).message}`);
        }
      }),
    );
  }

  tools(): ExternalTool[] {
    return this.offered;
  }

  /** Runs one tool call. Failures come back as text the model can read, never as a thrown error. */
  async call(name: string, args: unknown, signal?: AbortSignal): Promise<string> {
    const route = this.routes.get(name);
    if (!route) return `There is no tool named ${name}.`;
    const input = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
    try {
      const result = (await route.client.callTool({ name: route.tool, arguments: input }, undefined, { timeout: GUARD.mcpCallTimeoutMs, signal })) as {
        content?: { type: string; text?: string }[];
        structuredContent?: unknown;
        isError?: boolean;
      };
      const text =
        (result.content ?? [])
          .map((block) => (block.type === "text" ? (block.text ?? "") : `[${block.type} content omitted]`))
          .join("\n")
          .trim() || (result.structuredContent ? JSON.stringify(result.structuredContent) : "The tool returned nothing.");
      const cap = GUARD.maxToolResultChars;
      const capped = text.length > cap ? `${text.slice(0, cap)}\n[cut at ${cap} characters]` : text;
      return result.isError ? `The tool reported an error: ${capped}` : capped;
    } catch (err) {
      if (signal?.aborted) throw err;
      return `The ${route.server} tool failed: ${(err as Error).message}`;
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.clients.map((c) => c.close().catch(() => {})));
  }
}
