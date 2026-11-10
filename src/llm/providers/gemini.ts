import type { Content, GoogleGenAI } from "@google/genai";
import type { Source } from "../../domain/turn.ts";
import { EMPTY_TEXT, MAX_OUTPUT_TOKENS, REFUSAL_TEXT, SYSTEM_PROMPT } from "../prompt.ts";
import { citedFirst, pastPairs } from "../format.ts";
import { type TurnOptions, type TurnResult } from "../types.ts";

interface GeminiOptions extends TurnOptions {
  client: { models: Pick<GoogleGenAI["models"], "generateContentStream"> };
  model: string;
}

const BLOCKED = /SAFETY|BLOCK|PROHIBITED|RECITATION|SPII/;

export function geminiContents(options: Pick<TurnOptions, "history" | "userText" | "context" | "tz">): Content[] {
  const { history, userText, context, tz } = options;
  return [
    ...pastPairs(history, tz).flatMap((pair): Content[] => [
      { role: "user", parts: [{ text: pair.user }] },
      { role: "model", parts: [{ text: pair.assistant }] },
    ]),
    {
      role: "user",
      parts: [{ text: `<application_context>\n${context}\n</application_context>\n\n<user_message>\n${userText}\n</user_message>` }],
    },
  ];
}

export async function runGemini(options: GeminiOptions): Promise<TurnResult> {
  const { client, model, emit, signal } = options;
  const stream = await client.models.generateContentStream({
    model,
    contents: geminiContents(options),
    config: {
      systemInstruction: SYSTEM_PROMPT,
      tools: [{ googleSearch: {} }],
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: signal,
    },
  });

  const sources = new Map<string, Source>();
  const queries: string[] = [];
  let text = "";
  let stopReason: string | null = null;
  const usage = { model, inputTokens: 0, outputTokens: 0, searches: 0 };
  let chunks: { web?: { uri?: string; title?: string } }[] = [];

  for await (const response of stream) {
    // Each chunk reports running totals, so the latest one wins.
    if (response.usageMetadata) {
      const u = response.usageMetadata;
      usage.inputTokens = (u.promptTokenCount ?? 0) + (u.toolUsePromptTokenCount ?? 0);
      usage.outputTokens = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
    }
    const candidate = response.candidates?.[0];
    if (!candidate) {
      if (response.promptFeedback?.blockReason) stopReason = String(response.promptFeedback.blockReason);
      continue;
    }
    if (candidate.finishReason) stopReason = String(candidate.finishReason);

    for (const part of candidate.content?.parts ?? []) {
      if (part.text && !part.thought) {
        text += part.text;
        emit({ type: "text", text: part.text });
      }
    }

    const grounding = candidate.groundingMetadata;
    if (!grounding) continue;

    for (const query of grounding.webSearchQueries ?? []) {
      if (!queries.includes(query)) {
        queries.push(query);
        emit({ type: "search", query });
      }
    }
    if (grounding.groundingChunks?.length) chunks = grounding.groundingChunks;
    for (const chunk of chunks) {
      const uri = chunk.web?.uri;
      if (uri && !sources.has(uri)) sources.set(uri, { url: uri, title: chunk.web?.title ?? uri, cited: false });
    }
    for (const support of grounding.groundingSupports ?? []) {
      for (const index of support.groundingChunkIndices ?? []) {
        const uri = chunks[index]?.web?.uri;
        const known = uri ? sources.get(uri) : undefined;
        if (known) known.cited = true;
      }
    }
  }

  if (!text) {
    text = stopReason && BLOCKED.test(stopReason) ? REFUSAL_TEXT : EMPTY_TEXT;
    emit({ type: "text", text });
  }

  usage.searches = queries.length;
  const finalSources = citedFirst(sources);
  emit({ type: "sources", sources: finalSources });
  return { text, sources: finalSources, queries, stopReason, usage };
}
