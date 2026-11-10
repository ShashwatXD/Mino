import type OpenAI from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import type { Source } from "../store.ts";
import { citedFirst, EMPTY_TEXT, pastPairs, SYSTEM_PROMPT, type TurnOptions, type TurnResult } from "./shared.ts";

export interface OpenAIOptions extends TurnOptions {
  client: { responses: Pick<OpenAI["responses"], "stream"> };
  model: string;
}

export function openaiInput(options: Pick<TurnOptions, "history" | "userText" | "context" | "tz">): ResponseInput {
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
  const stream = client.responses.stream(
    {
      model,
      instructions: SYSTEM_PROMPT,
      input: openaiInput(options),
      tools: [{ type: "web_search" }],
    },
    { signal },
  );

  const sources = new Map<string, Source>();
  const queries: string[] = [];
  let text = "";
  let stopReason: string | null = null;

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
        break;
      case "response.failed":
        throw new Error(event.response?.error?.message ?? "The response failed");
    }
  }

  if (!text) {
    text = EMPTY_TEXT;
    emit({ type: "text", text });
  }

  const finalSources = citedFirst(sources);
  emit({ type: "sources", sources: finalSources });
  return { text, sources: finalSources, queries, stopReason };
}
