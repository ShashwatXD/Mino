import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import type { Provider } from "../../config/config.ts";
import type { Usage } from "../types.ts";

/** Small-model calls return plain text. None is ever given a tool. */
export interface Completion {
  text: string;
  usage: Usage;
}

const MAX_TOKENS = 1024;

type Complete = (system: string, prompt: string, signal: AbortSignal) => Promise<Completion>;

export function completer(provider: Provider, apiKey: string, model: string): Complete {
  if (provider === "gemini") {
    const client = new GoogleGenAI({ apiKey });
    return async (system, prompt, signal) => {
      const response = await client.models.generateContent({
        model,
        contents: prompt,
        config: {
          systemInstruction: system,
          maxOutputTokens: MAX_TOKENS,
          abortSignal: signal,
        },
      });
      const u = response.usageMetadata;
      return {
        text: response.text ?? "",
        usage: { model, inputTokens: u?.promptTokenCount ?? 0, outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0), searches: 0 },
      };
    };
  }
  if (provider === "anthropic") {
    const client = new Anthropic({ apiKey });
    return async (system, prompt, signal) => {
      const response = await client.messages.create(
        {
          model,
          max_tokens: MAX_TOKENS,
          system,
          output_config: { effort: "low" },
          messages: [{ role: "user", content: prompt }],
        },
        { signal },
      );
      const block = response.content.find((b) => b.type === "text");
      return {
        text: block?.type === "text" ? block.text : "",
        usage: { model, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, searches: 0 },
      };
    };
  }
  const client = new OpenAI({ apiKey });
  return async (system, prompt, signal) => {
    const response = await client.responses.create(
      {
        model,
        instructions: system,
        input: prompt,
        max_output_tokens: MAX_TOKENS,
      },
      { signal },
    );
    return {
      text: response.output_text,
      usage: { model, inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0, searches: 0 },
    };
  };
}

export const renderTurns = (turns: { user: string; assistant: string }[]) =>
  turns.map((t) => `User: ${t.user}\nAssistant: ${t.assistant}`).join("\n\n");
