import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import type { AppConfig } from "../config/config.ts";
import { runTurn } from "./providers/anthropic.ts";
import { runGemini } from "./providers/gemini.ts";
import { runOpenAI } from "./providers/openai.ts";
import type { Engine } from "./types.ts";

export function createEngine(config: Pick<AppConfig, "provider" | "apiKey" | "model" | "effort">): Engine | null {
  const { provider, apiKey, model, effort } = config;
  if (!provider || !apiKey || !model) return null;

  switch (provider) {
    case "gemini": {
      const client = new GoogleGenAI({ apiKey });
      return { provider, model, run: (options) => runGemini({ ...options, client, model, effort }) };
    }
    case "anthropic": {
      const client = new Anthropic({ apiKey });
      return { provider, model, run: (options) => runTurn({ ...options, client, model, effort }) };
    }
    case "openai": {
      const client = new OpenAI({ apiKey });
      return { provider, model, run: (options) => runOpenAI({ ...options, client, model, effort }) };
    }
  }
}
