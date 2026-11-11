import { z } from "zod";

export const PROVIDERS = ["gemini", "anthropic", "openai"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export const DEFAULT_MODELS: Record<Provider, string> = {
  gemini: "gemini-3.8-flash",
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-6.1-terra",
};

const blankToUndefined = (value: unknown) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

export const KeySchema = z.preprocess(
  blankToUndefined,
  z
    .string()
    .min(20, "is too short to be an API key")
    .regex(/^\S+$/, "contains spaces")
    .refine((v) => !/^(your|xxx|changeme|replace|<)/i.test(v), "still holds a placeholder")
    .optional(),
);

const SettingsSchema = z.object({
  PROVIDER: z.preprocess(blankToUndefined, z.enum(PROVIDERS).optional()),
  MODEL: z.preprocess(blankToUndefined, z.string().optional()),
  EFFORT: z.preprocess(blankToUndefined, z.enum(EFFORTS).default("low")),
  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65535).default(3000)),
  DAILY_BUDGET_USD: z.preprocess(blankToUndefined, z.coerce.number().min(0).default(1)),
  MAX_MESSAGES_PER_MINUTE: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).default(10)),
  MAX_MESSAGES_PER_DAY: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).default(200)),
});

export const ChatRequestSchema = z.object({
  message: z.string().trim().min(1, "Message is required").max(20000, "Message is too long"),
  threadId: z.string().min(1).max(100).optional(),
  timezone: z.string().max(64).optional(),
  incognito: z.boolean().optional(),
  thinkMore: z.boolean().optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/** Prefixes identify a key even when it was pasted into the wrong variable. */
export function providerOfKey(key: string): Provider | undefined {
  if (key.startsWith("AIza")) return "gemini";
  if (key.startsWith("sk-ant-")) return "anthropic";
  if (key.startsWith("sk-")) return "openai";
  return undefined;
}

const KEY_SLOTS: { name: string; provider: Provider | undefined }[] = [
  { name: "GEMINI_API_KEY", provider: "gemini" },
  { name: "GOOGLE_API_KEY", provider: "gemini" },
  { name: "ANTHROPIC_API_KEY", provider: "anthropic" },
  { name: "OPENAI_API_KEY", provider: "openai" },
  { name: "API_KEY", provider: undefined },
];

export const MODEL_PATTERNS: Record<Provider, RegExp> = {
  gemini: /^(models\/)?gemini-/,
  anthropic: /^claude-/,
  openai: /^(gpt-|o\d|chatgpt-)/,
};

export interface Limits {
  dailyBudgetUsd: number;
  maxPerMinute: number;
  maxPerDay: number;
  maxConcurrent: number;
}

export interface AppConfig {
  provider: Provider | null;
  apiKey: string | null;
  keys: Partial<Record<Provider, string>>;
  model: string | null;
  effort: Effort;
  port: number;
  available: Provider[];
  warnings: string[];
  limits: Limits;
}

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = SettingsSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`Invalid settings in .env. ${problems}`);
  }
  const settings = parsed.data;
  const warnings: string[] = [];
  const keys = new Map<Provider, string>();

  // A bad key only disables its own engine, so any other valid key still runs.
  for (const slot of KEY_SLOTS) {
    const result = KeySchema.safeParse(env[slot.name]);
    if (!result.success) {
      warnings.push(`${slot.name} was ignored: it ${result.error.issues[0].message}.`);
      continue;
    }
    if (!result.data) continue;
    const detected = providerOfKey(result.data);
    const provider = detected ?? slot.provider ?? "gemini";
    if (detected && slot.provider && detected !== slot.provider) {
      warnings.push(`${slot.name} holds a key for ${detected}, so ${detected} is being used.`);
    }
    if (!keys.has(provider)) keys.set(provider, result.data);
  }

  const available = PROVIDERS.filter((p) => keys.has(p));
  if (settings.PROVIDER && !keys.has(settings.PROVIDER)) {
    if (available.length === 0) warnings.push(`PROVIDER is ${settings.PROVIDER}, but no usable key was found.`);
    else warnings.push(`PROVIDER is ${settings.PROVIDER}, but it has no usable key. Using ${available[0]} instead.`);
  }

  const provider = settings.PROVIDER && keys.has(settings.PROVIDER) ? settings.PROVIDER : (available[0] ?? null);
  let model: string | null = null;
  if (provider) {
    model = DEFAULT_MODELS[provider];
    if (settings.MODEL) {
      if (MODEL_PATTERNS[provider].test(settings.MODEL)) model = settings.MODEL;
      else warnings.push(`MODEL ${settings.MODEL} does not belong to ${provider}, so ${model} is being used.`);
    }
  }

  return {
    provider,
    apiKey: provider ? keys.get(provider)! : null,
    keys: Object.fromEntries(keys),
    model,
    effort: settings.EFFORT,
    port: settings.PORT,
    available,
    warnings,
    limits: {
      dailyBudgetUsd: settings.DAILY_BUDGET_USD,
      maxPerMinute: settings.MAX_MESSAGES_PER_MINUTE,
      maxPerDay: settings.MAX_MESSAGES_PER_DAY,
      maxConcurrent: 2,
    },
  };
}
