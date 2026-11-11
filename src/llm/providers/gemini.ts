import { ThinkingLevel, type Content, type GoogleGenAI, type Part } from "@google/genai";
import type { Effort } from "../../config/config.ts";
import type { Source } from "../../domain/turn.ts";
import { citedFirst, pastPairs } from "../format.ts";
import { EMPTY_TEXT, MAX_OUTPUT_TOKENS, REFUSAL_TEXT, SYSTEM_PROMPT } from "../prompt.ts";
import { HISTORY_TOOL, MAX_HISTORY_CALLS, runHistoryTool } from "../tools.ts";
import { type TurnOptions, type TurnResult } from "../types.ts";

interface GeminiOptions extends TurnOptions {
  client: { models: Pick<GoogleGenAI["models"], "generateContentStream"> };
  model: string;
  effort?: Effort;
}

const BLOCKED = /SAFETY|BLOCK|PROHIBITED|RECITATION|SPII/;
const THINKING: Record<Effort, ThinkingLevel> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
  xhigh: ThinkingLevel.HIGH,
  max: ThinkingLevel.HIGH,
};

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
  const contents = geminiContents(options);
  const withHistory = Boolean(options.searchHistory);
  const config = {
    systemInstruction: SYSTEM_PROMPT,
    tools: [{ googleSearch: {} }, ...(withHistory ? [{ functionDeclarations: [{ name: HISTORY_TOOL.name, description: HISTORY_TOOL.description, parametersJsonSchema: HISTORY_TOOL.parameters }] }] : [])],
    // Search calls come back as parts, so they can be replayed with the history results in the next round.
    ...(withHistory ? { toolConfig: { includeServerSideToolInvocations: true } } : {}),
    thinkingConfig: { thinkingLevel: THINKING[options.effort ?? "medium"] },
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    abortSignal: signal,
  };

  const sources = new Map<string, Source>();
  const queries: string[] = [];
  let text = "";
  let stopReason: string | null = null;
  const usage = { model, inputTokens: 0, outputTokens: 0, searches: 0 };
  let historyCalls = 0;

  // One round past the limit lets the model answer after being told to stop searching.
  for (let round = 0; round <= MAX_HISTORY_CALLS + 1; round++) {
    const stream = await client.models.generateContentStream({ model, contents, config });
    const parts: Part[] = [];
    const calls: { id?: string; name?: string; args?: unknown }[] = [];
    let chunks: { web?: { uri?: string; title?: string } }[] = [];
    let roundUsage = { input: 0, output: 0 };

    for await (const response of stream) {
      // Each chunk reports running totals for its round, so the latest one wins.
      if (response.usageMetadata) {
        const u = response.usageMetadata;
        roundUsage = { input: (u.promptTokenCount ?? 0) + (u.toolUsePromptTokenCount ?? 0), output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) };
      }
      const candidate = response.candidates?.[0];
      if (!candidate) {
        if (response.promptFeedback?.blockReason) stopReason = String(response.promptFeedback.blockReason);
        continue;
      }
      if (candidate.finishReason) stopReason = String(candidate.finishReason);

      for (const part of candidate.content?.parts ?? []) {
        parts.push(part);
        if (part.functionCall) calls.push(part.functionCall);
        else if (part.text && !part.thought) {
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
    usage.inputTokens += roundUsage.input;
    usage.outputTokens += roundUsage.output;
    if (calls.length === 0) break;

    // The model's parts go back unchanged, because their thought signatures must match.
    contents.push({ role: "model", parts });
    contents.push({
      role: "user",
      parts: calls.map((call) => ({
        functionResponse: { id: call.id, name: call.name, response: { output: runHistoryTool(options, call.args, historyCalls++) } },
      })),
    });
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
