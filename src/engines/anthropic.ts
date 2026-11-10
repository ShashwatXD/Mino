import Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "../config.ts";
import type { Source, Turn } from "../store.ts";
import { citedFirst, EMPTY_TEXT, MAX_OUTPUT_TOKENS, MAX_SEARCHES, pastPairs, REFUSAL_TEXT, SYSTEM_PROMPT, type TurnOptions, type TurnResult } from "./shared.ts";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

interface AnthropicOptions extends TurnOptions {
  client: Pick<Anthropic, "beta">;
  model: string;
  effort: Effort;
}

const MAX_CONTINUATIONS = 2;

/** Replays plain text only, so history stays a stable, cacheable, append-only prefix. */
function historyMessages(history: Turn[], tz: string): MessageParam[] {
  const pairs = pastPairs(history, tz);
  return pairs.flatMap((pair, i): MessageParam[] => [
    { role: "user", content: pair.user },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: pair.assistant,
          ...(i === pairs.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
        },
      ],
    },
  ]);
}

export async function runTurn(options: AnthropicOptions): Promise<TurnResult> {
  const { client, model, effort, history, userText, context, tz, emit, signal } = options;
  const messages: MessageParam[] = [
    ...historyMessages(history, tz),
    { role: "user", content: userText },
    // Sent as an operator message, after the cached prefix, so the changing clock never breaks caching.
    { role: "system", content: context } as unknown as MessageParam,
  ];

  const sources = new Map<string, Source>();
  const queries: string[] = [];
  let text = "";
  let stopReason: string | null = null;
  const usage = { model, inputTokens: 0, outputTokens: 0, searches: 0 };

  for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
    const stream = client.beta.messages.stream(
      {
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort },
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: options.maxSearches ?? MAX_SEARCHES }],
        messages,
      } as unknown as Anthropic.Beta.Messages.MessageCreateParamsStreaming,
      { signal },
    );

    const toolInputs = new Map<number, string>();

    for await (const event of stream as AsyncIterable<any>) {
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "server_tool_use" && block.name === "web_search") {
          toolInputs.set(event.index, "");
        } else if (block.type === "web_search_tool_result") {
          if (Array.isArray(block.content)) {
            for (const r of block.content) {
              if (r.type === "web_search_result" && !sources.has(r.url)) {
                sources.set(r.url, { url: r.url, title: r.title, pageAge: r.page_age ?? undefined, cited: false });
              }
            }
          } else {
            emit({ type: "status", text: "A search failed, continuing with what is available" });
          }
        }
      } else if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta.type === "text_delta") {
          text += delta.text;
          emit({ type: "text", text: delta.text });
        } else if (delta.type === "input_json_delta" && toolInputs.has(event.index)) {
          toolInputs.set(event.index, toolInputs.get(event.index) + delta.partial_json);
        } else if (delta.type === "citations_delta" && delta.citation?.url) {
          const { url, title } = delta.citation;
          const known = sources.get(url);
          sources.set(url, { url, title: known?.title ?? title ?? url, pageAge: known?.pageAge, cited: true });
        }
      } else if (event.type === "content_block_stop" && toolInputs.has(event.index)) {
        try {
          const query = JSON.parse(toolInputs.get(event.index) || "{}").query;
          if (typeof query === "string" && query) {
            queries.push(query);
            emit({ type: "search", query });
          }
        } catch {
          // A malformed partial input only costs the status line; the server still ran the search.
        }
        toolInputs.delete(event.index);
      }
    }

    const message = await stream.finalMessage();
    stopReason = message.stop_reason;
    const reported = message.usage as any;
    usage.inputTokens += (reported?.input_tokens ?? 0) + (reported?.cache_read_input_tokens ?? 0) + (reported?.cache_creation_input_tokens ?? 0);
    usage.outputTokens += reported?.output_tokens ?? 0;
    usage.searches += reported?.server_tool_use?.web_search_requests ?? 0;
    if (stopReason !== "pause_turn") break;
    // The server resumes from the trailing server_tool_use block; no extra user message is added.
    messages.push({ role: "assistant", content: message.content as never });
  }

  if (!text) {
    text = stopReason === "refusal" ? REFUSAL_TEXT : EMPTY_TEXT;
    emit({ type: "text", text });
  }

  const finalSources = citedFirst(sources);
  emit({ type: "sources", sources: finalSources });
  return { text, sources: finalSources, queries, stopReason, usage };
}
