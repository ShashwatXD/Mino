import type OpenAI from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import type { Effort } from "../../config/config.ts";
import type { Source } from "../../domain/turn.ts";
import { GUARD } from "../../config/guardrails.ts";
import { EMPTY_TEXT, SYSTEM_PROMPT } from "../prompt.ts";
import { errorText, readableMessages, readableTools, snapshot } from "../call-record.ts";
import { citedFirst, paragraphJoin, pastPairs } from "../format.ts";
import { type CallCounter, functionTools, runFunctionCall } from "../tools.ts";
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
    ...functionTools(options).map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.parameters, strict: false })),
  ];

  const sources = new Map<string, Source>();
  const queries: string[] = [];
  let text = "";
  let stopReason: string | null = null;
  const usage = { model, inputTokens: 0, outputTokens: 0, searches: 0 };
  const count: CallCounter = { history: 0, external: 0 };
  let newRound = false;

  for (let round = 0; round < GUARD.maxRounds; round++) {
    const params = {
      model,
      instructions: SYSTEM_PROMPT,
      input,
      tools,
      reasoning: { effort: REASONING[options.effort ?? "low"] },
      max_output_tokens: GUARD.maxOutputTokens,
      max_tool_calls: options.maxSearches ?? GUARD.maxWebSearches,
    };
    const sentAt = performance.now();
    const sent = options.onLlmCall ? snapshot(params) : null;
    let output: any[] = [];
    let finalResponse: any = null;
    let roundText = "";
    const roundQueries: string[] = [];
    const record = (error?: unknown) =>
      options.onLlmCall?.({
        purpose: "answer",
        round: round + 1,
        provider: "openai",
        model,
        startedAt: sentAt,
        durationMs: Math.round(performance.now() - sentAt),
        request: {
          system: SYSTEM_PROMPT,
          messages: readableMessages((sent as { input: unknown[] }).input),
          tools: readableTools(tools),
          settings: { reasoning: params.reasoning, max_output_tokens: params.max_output_tokens, max_tool_calls: params.max_tool_calls },
        },
        response: {
          text: roundText,
          thoughts: output.filter((i) => i.type === "reasoning").flatMap((i) => (i.summary ?? []).map((s: any) => s.text)).join("\n\n"),
          toolCalls: output.filter((i) => i.type === "function_call").map((i) => ({ name: i.name, args: i.arguments })),
          stopReason: finalResponse?.status ?? null,
          webQueries: roundQueries,
          sources: [],
        },
        usage: {
          model,
          inputTokens: finalResponse?.usage?.input_tokens ?? 0,
          outputTokens: finalResponse?.usage?.output_tokens ?? 0,
          searches: output.filter((i) => i.type === "web_search_call").length,
          thinkingTokens: finalResponse?.usage?.output_tokens_details?.reasoning_tokens ?? 0,
          cachedTokens: finalResponse?.usage?.input_tokens_details?.cached_tokens ?? 0,
        },
        raw: { request: sent, response: snapshot(finalResponse) },
        ...(error ? { error: errorText(error) } : {}),
      });

    try {
      const stream = client.responses.stream(params as never, { signal });

      for await (const event of stream as AsyncIterable<any>) {
        switch (event.type) {
          case "response.output_text.delta":
          case "response.refusal.delta":
            const piece = paragraphJoin(text, event.delta, newRound);
            newRound = false;
            text += piece;
            roundText += piece;
            emit({ type: "text", text: piece });
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
                  roundQueries.push(query);
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
            finalResponse = event.response ?? null;
            break;
          case "response.failed":
            throw new Error(event.response?.error?.message ?? "The response failed");
        }
      }

    } catch (err) {
      record(err);
      throw err;
    }
    record();
    const calls = output.filter((item) => item.type === "function_call");
    if (calls.length === 0) break;
    // Output items, reasoning included, go back unchanged so the model continues its own chain.
    newRound = true;
    input.push(...output);
    for (const call of calls) input.push({ type: "function_call_output", call_id: call.call_id, output: await runFunctionCall(options, call.name, call.arguments, count) } as never);
  }

  if (!text) {
    text = EMPTY_TEXT;
    emit({ type: "text", text });
  }

  const finalSources = citedFirst(sources);
  emit({ type: "sources", sources: finalSources });
  return { text, sources: finalSources, queries, stopReason, usage };
}
