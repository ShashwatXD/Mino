import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import type { AppConfig } from "../config.ts";
import { runTurn } from "./anthropic.ts";
import { runGemini } from "./gemini.ts";
import { runOpenAI } from "./openai.ts";
import type { Engine } from "./shared.ts";

/** Starts whichever engine the configuration resolved to, or none when no key is usable. */
export function createEngine(config: AppConfig): Engine | null {
  const { provider, apiKey, model, effort } = config;
  if (!provider || !apiKey || !model) return null;

  switch (provider) {
    case "gemini": {
      const client = new GoogleGenAI({ apiKey });
      return { provider, model, run: (options) => runGemini({ ...options, client, model }) };
    }
    case "anthropic": {
      const client = new Anthropic({ apiKey });
      return { provider, model, run: (options) => runTurn({ ...options, client, model, effort }) };
    }
    case "openai": {
      const client = new OpenAI({ apiKey });
      return { provider, model, run: (options) => runOpenAI({ ...options, client, model }) };
    }
  }
}
