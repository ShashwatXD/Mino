import { ThinkingLevel, type Content, type GoogleGenAI, type Part } from "@google/genai";
import type { Effort } from "../../config/config.ts";
import type { Source } from "../../domain/turn.ts";
import { errorText, readableMessages, readableTools, snapshot } from "../call-record.ts";
import { citedFirst, paragraphJoin, pastPairs } from "../format.ts";
import { GUARD } from "../../config/guardrails.ts";
import { EMPTY_TEXT, REFUSAL_TEXT, SYSTEM_PROMPT } from "../prompt.ts";
import { type CallCounter, functionTools, runFunctionCall } from "../tools.ts";
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
  const declared = functionTools(options);
  const config = {
    systemInstruction: SYSTEM_PROMPT,
    tools: [{ googleSearch: {} }, ...(declared.length ? [{ functionDeclarations: declared.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }] : [])],
    // Search calls then stream as parts the moment they start, which also lets them be replayed after a history lookup.
    toolConfig: { includeServerSideToolInvocations: true },
    // Thought summaries come back as parts marked `thought`: never shown in the answer, only recorded in the trace.
    thinkingConfig: { thinkingLevel: THINKING[options.effort ?? "low"], includeThoughts: true },
    maxOutputTokens: GUARD.maxOutputTokens,
    abortSignal: signal,
  };

  const sources = new Map<string, Source>();
  const queries: string[] = [];
  let text = "";
  let stopReason: string | null = null;
  const usage = { model, inputTokens: 0, outputTokens: 0, searches: 0 };
  const count: CallCounter = { history: 0, external: 0 };
  let newRound = false;

  for (let round = 0; round < GUARD.maxRounds; round++) {
    const sentAt = performance.now();
    const sent = options.onLlmCall ? snapshot({ model, contents, config }) : null;
    const parts: Part[] = [];
    const calls: { id?: string; name?: string; args?: unknown }[] = [];
    let chunks: { web?: { uri?: string; title?: string } }[] = [];
    let roundUsage = { input: 0, output: 0 };
    let rawUsage: unknown = null;
    let rawGrounding: unknown = null;
    let roundText = "";
    let roundThoughts = "";
    const roundQueries: string[] = [];
    const record = (error?: unknown) =>
      options.onLlmCall?.({
        purpose: "answer",
        round: round + 1,
        provider: "gemini",
        model,
        startedAt: sentAt,
        durationMs: Math.round(performance.now() - sentAt),
        request: {
          system: SYSTEM_PROMPT,
          messages: readableMessages((sent as { contents: unknown[] }).contents),
          tools: readableTools(config.tools),
          settings: { thinkingLevel: config.thinkingConfig.thinkingLevel, maxOutputTokens: config.maxOutputTokens, includeServerSideToolInvocations: true },
        },
        response: {
          text: roundText,
          thoughts: roundThoughts,
          toolCalls: calls.map((c) => ({ name: c.name ?? "", args: c.args ?? {} })),
          stopReason,
          webQueries: roundQueries,
          sources: chunks.flatMap((c) => (c.web?.uri ? [{ url: c.web.uri, title: c.web.title ?? c.web.uri }] : [])),
        },
        usage: {
          model,
          inputTokens: roundUsage.input,
          outputTokens: roundUsage.output,
          searches: roundQueries.length,
          thinkingTokens: (rawUsage as { thoughtsTokenCount?: number } | null)?.thoughtsTokenCount ?? 0,
          cachedTokens: (rawUsage as { cachedContentTokenCount?: number } | null)?.cachedContentTokenCount ?? 0,
        },
        raw: { request: sent, response: snapshot({ parts, finishReason: stopReason, usageMetadata: rawUsage, groundingMetadata: rawGrounding }) },
        ...(error ? { error: errorText(error) } : {}),
      });

    try {
      const stream = await client.models.generateContentStream({ model, contents, config });
      for await (const response of stream) {
        // Each chunk reports running totals for its round, so the latest one wins.
        if (response.usageMetadata) {
          const u = response.usageMetadata;
          rawUsage = u;
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
          if (part.toolCall && String(part.toolCall.toolType).includes("SEARCH")) {
            const started = part.toolCall.args?.queries;
            for (const query of Array.isArray(started) ? started : []) {
              if (typeof query === "string" && !queries.includes(query)) {
                queries.push(query);
                roundQueries.push(query);
                emit({ type: "search", query });
              }
            }
          }
          if (part.functionCall) calls.push(part.functionCall);
          else if (part.text && part.thought) roundThoughts += part.text;
          else if (part.text) {
            const piece = paragraphJoin(text, part.text, newRound);
            newRound = false;
            text += piece;
            roundText += piece;
            emit({ type: "text", text: piece });
          }
        }

        const grounding = candidate.groundingMetadata;
        if (!grounding) continue;
        rawGrounding = grounding;
        for (const query of grounding.webSearchQueries ?? []) {
          if (!queries.includes(query)) {
            queries.push(query);
            roundQueries.push(query);
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
    } catch (err) {
      record(err);
      throw err;
    }
    record();
    usage.inputTokens += roundUsage.input;
    usage.outputTokens += roundUsage.output;
    if (calls.length === 0) break;

    newRound = true;
    // The model's parts go back unchanged, because their thought signatures must match.
    contents.push({ role: "model", parts });
    // Calls run one at a time so the per-reply limits count them in order.
    const responses: Part[] = [];
    for (const call of calls) {
      responses.push({ functionResponse: { id: call.id, name: call.name, response: { output: await runFunctionCall(options, call.name, call.args, count) } } });
    }
    contents.push({ role: "user", parts: responses });
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
