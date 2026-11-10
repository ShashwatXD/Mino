import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import type { Provider } from "../config.ts";

const GEMINI_SKIP = /embedding|image|tts|audio|live|robotics|computer-use|aqa/i;
// The Claude engine needs hosted search and mid-conversation system messages together.
const CLAUDE_SUPPORTED = /^claude-(opus-(5-5|5|4-8)|sonnet-5-5|fable-|mythos-)/;
const OPENAI_CHAT = /^(gpt-|o\d)/;
const OPENAI_SKIP = /audio|realtime|image|transcribe|tts|embedding|search-preview|instruct|codex|-\d{4}-\d{2}-\d{2}$/i;

/** Lists the chat models a key can use. Also proves the key works, at no token cost. */
export async function listModels(provider: Provider, apiKey: string): Promise<string[]> {
  const ids: string[] = [];
  if (provider === "gemini") {
    const pager = await new GoogleGenAI({ apiKey }).models.list();
    for await (const model of pager) {
      const id = model.name?.replace(/^models\//, "") ?? "";
      if (id.startsWith("gemini-") && !GEMINI_SKIP.test(id) && model.supportedActions?.includes("generateContent")) ids.push(id);
    }
  } else if (provider === "anthropic") {
    for await (const model of new Anthropic({ apiKey }).models.list()) {
      if (CLAUDE_SUPPORTED.test(model.id)) ids.push(model.id);
    }
  } else {
    for await (const model of new OpenAI({ apiKey }).models.list()) {
      if (OPENAI_CHAT.test(model.id) && !OPENAI_SKIP.test(model.id)) ids.push(model.id);
    }
  }
  return ids.sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
}
