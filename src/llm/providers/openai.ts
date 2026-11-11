import type OpenAI from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import type { Effort } from "../../config/config.ts";
import type { Source } from "../../domain/turn.ts";
import { EMPTY_TEXT, MAX_OUTPUT_TOKENS, MAX_SEARCHES, SYSTEM_PROMPT } from "../prompt.ts";
import { citedFirst, pastPairs } from "../format.ts";
import { HISTORY_TOOL, MAX_HISTORY_CALLS, runHistoryTool } from "../tools.ts";
import { type TurnOptions, type TurnResult } from "../types.ts";

interface OpenAIOptions extends TurnOptions {
  client: { responses: Pick<OpenAI["responses"], "stream"> };
  model: string;
  effort?: Effort;
}

const REASONING: Record<Effort, "low" | "medium" | "high"> = { low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };

function openaiInput(options: Pick<TurnOptions, "history" | "userText" | "context" | "tz">): ResponseInput {
  const { history, userText, context, tz } = options;
  return [
    ...pastPairs(history, tz).flatMap((pair): ResponseInput => [
      { role: "user", content: pair.user },
      { role: "assistant", content: pair.assistant },
    ]),
    { role: "user", content: userText },
    { role: "developer", content: context },
  ];
}

export async function runOpenAI(options: OpenAIOptions): Promise<TurnResult> {
  const { client, model, emit, signal } = options;
  const input = openaiInput(options);
  const tools = [
    { type: "web_search" as const },
    ...(options.searchHistory ? [{ type: "function" as const, name: HISTORY_TOOL.name, description: HISTORY_TOOL.description, parameters: HISTORY_TOOL.parameters, strict: false }] : []),
  ];

  const sources = new Map<string, Source>();
  const queries: string[] = [];
  let text = "";
  let stopReason: string | null = null;
  const usage = { model, inputTokens: 0, outputTokens: 0, searches: 0 };
  let historyCalls = 0;

  // One round past the limit lets the model answer after being told to stop searching.
  for (let round = 0; round <= MAX_HISTORY_CALLS + 1; round++) {
    const stream = client.responses.stream(
      {
        model,
        instructions: SYSTEM_PROMPT,
        input,
        tools,
        reasoning: { effort: REASONING[options.effort ?? "medium"] },
        max_output_tokens: MAX_OUTPUT_TOKENS,
        max_tool_calls: options.maxSearches ?? MAX_SEARCHES,
      } as never,
      { signal },
    );
    let output: any[] = [];

    for await (const event of stream as AsyncIterable<any>) {
      switch (event.type) {
        case "response.output_text.delta":
        case "response.refusal.delta":
          text += event.delta;
          emit({ type: "text", text: event.delta });
          break;
        case "response.web_search_call.searching":
          emit({ type: "status", text: "Searching the web" });
          break;
        case "response.output_text.annotation.added":
          if (event.annotation?.type === "url_citation" && event.annotation.url) {
            const { url, title } = event.annotation;
            sources.set(url, { url, title: title || url, cited: true });
          }
          break;
        case "response.output_item.done": {
          const action = event.item?.type === "web_search_call" ? event.item.action : undefined;
          if (event.item?.type === "web_search_call") usage.searches++;
          if (action?.type === "search") {
            for (const query of action.queries ?? (action.query ? [action.query] : [])) {
              if (!queries.includes(query)) {
                queries.push(query);
                emit({ type: "search", query });
              }
            }
          }
          break;
        }
        case "response.completed":
        case "response.incomplete":
          stopReason = event.response?.status ?? event.type;
          usage.inputTokens += event.response?.usage?.input_tokens ?? 0;
          usage.outputTokens += event.response?.usage?.output_tokens ?? 0;
          output = event.response?.output ?? [];
          break;
        case "response.failed":
          throw new Error(event.response?.error?.message ?? "The response failed");
      }
    }

    const calls = output.filter((item) => item.type === "function_call" && item.name === HISTORY_TOOL.name);
    if (calls.length === 0) break;
    // Output items, reasoning included, go back unchanged so the model continues its own chain.
    input.push(...output);
    for (const call of calls) input.push({ type: "function_call_output", call_id: call.call_id, output: runHistoryTool(options, call.arguments, historyCalls++) } as never);
  }

  if (!text) {
    text = EMPTY_TEXT;
    emit({ type: "text", text });
  }

  const finalSources = citedFirst(sources);
  emit({ type: "sources", sources: finalSources });
  return { text, sources: finalSources, queries, stopReason, usage };
}
