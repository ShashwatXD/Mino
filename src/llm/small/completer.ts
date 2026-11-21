import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import type { Provider } from "../../config/config.ts";
import { GUARD } from "../../config/guardrails.ts";
import { errorText, type LlmCallRecord, snapshot } from "../call-record.ts";
import type { Usage } from "../types.ts";

/** Small-model calls return plain text. None is ever given a tool. */
export interface Completion {
  text: string;
  usage: Usage;
  /** The full request and response, for the traces page. */
  record?: LlmCallRecord;
}

type Complete = (system: string, prompt: string, signal: AbortSignal) => Promise<Completion>;

type Call = (system: string, prompt: string, signal: AbortSignal) => Promise<{ text: string; usage: Usage; request: unknown; response: unknown }>;

export function completer(provider: Provider, apiKey: string, model: string, purpose: LlmCallRecord["purpose"] = "summary"): Complete {
  const call = providerCall(provider, apiKey, model);
  return async (system, prompt, signal) => {
    const sentAt = performance.now();
    const base = {
      purpose,
      provider,
      model,
      startedAt: sentAt,
      request: { system, messages: [{ role: "user", content: prompt }], tools: [], settings: { maxOutputTokens: GUARD.smallModelMaxTokens } },
    };
    try {
      const { text, usage, request, response } = await call(system, prompt, signal);
      const record: LlmCallRecord = {
        ...base,
        durationMs: Math.round(performance.now() - sentAt),
        response: { text, thoughts: "", toolCalls: [], stopReason: null, webQueries: [], sources: [] },
        usage,
        raw: { request: snapshot(request), response: snapshot(response) },
      };
      return { text, usage, record };
    } catch (err) {
      // The caller sees the error; the record rides on it so a failed call still shows on the traces page.
      const record: LlmCallRecord = {
        ...base,
        durationMs: Math.round(performance.now() - sentAt),
        response: { text: "", thoughts: "", toolCalls: [], stopReason: null, webQueries: [], sources: [] },
        usage: { model, inputTokens: 0, outputTokens: 0, searches: 0 },
        raw: { request: null, response: null },
        error: errorText(err),
      };
      if (err && typeof err === "object") Object.assign(err, { record });
      throw err;
    }
  };
}

function providerCall(provider: Provider, apiKey: string, model: string): Call {
  if (provider === "gemini") {
    const client = new GoogleGenAI({ apiKey });
    return async (system, prompt, signal) => {
      const request = {
        model,
        contents: prompt,
        config: {
          systemInstruction: system,
          maxOutputTokens: GUARD.smallModelMaxTokens,
          abortSignal: signal,
        },
      };
      const response = await client.models.generateContent(request);
      const u = response.usageMetadata;
      return {
        text: response.text ?? "",
        usage: { model, inputTokens: u?.promptTokenCount ?? 0, outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0), searches: 0 },
        request,
        response: { candidates: response.candidates, usageMetadata: response.usageMetadata },
      };
    };
  }
  if (provider === "anthropic") {
    const client = new Anthropic({ apiKey });
    return async (system, prompt, signal) => {
      const request = {
        model,
        max_tokens: GUARD.smallModelMaxTokens,
        system,
        output_config: { effort: "low" as const },
        messages: [{ role: "user" as const, content: prompt }],
      };
      const response = await client.messages.create(request, { signal });
      const block = response.content.find((b) => b.type === "text");
      return {
        text: block?.type === "text" ? block.text : "",
        usage: { model, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, searches: 0 },
        request,
        response,
      };
    };
  }
  const client = new OpenAI({ apiKey });
  return async (system, prompt, signal) => {
    const request = {
      model,
      instructions: system,
      input: prompt,
      max_output_tokens: GUARD.smallModelMaxTokens,
    };
    const response = await client.responses.create(request, { signal });
    return {
      text: response.output_text,
      usage: { model, inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0, searches: 0 },
      request,
      response,
    };
  };
}

export const renderTurns = (turns: { user: string; assistant: string }[]) =>
  turns.map((t) => `User: ${t.user}\nAssistant: ${t.assistant}`).join("\n\n");
