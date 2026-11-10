import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { DEFAULT_MODELS, KeySchema, MODEL_PATTERNS, PROVIDERS, providerOfKey, type AppConfig, type Provider } from "./config.ts";
import { createEngine } from "./engines/index.ts";
import { listModels as realListModels } from "./engines/models.ts";
import type { Engine } from "./engines/shared.ts";

const PROVIDER_INFO: Record<Provider, { label: string; keyUrl: string }> = {
  gemini: { label: "Gemini", keyUrl: "https://aistudio.google.com/apikey" },
  anthropic: { label: "Claude", keyUrl: "https://console.anthropic.com/settings/keys" },
  openai: { label: "OpenAI", keyUrl: "https://platform.openai.com/api-keys" },
};

const ProviderSchema = z.enum(PROVIDERS);
export const SetKeySchema = z.object({ provider: ProviderSchema, key: z.string() });
export const RemoveKeySchema = z.object({ provider: ProviderSchema });
export const SetModelSchema = z.object({ provider: ProviderSchema, model: z.string().min(1).max(100) });

const FileSchema = z.object({
  keys: z.record(z.string(), z.string()).default({}),
  selected: z.object({ provider: ProviderSchema, model: z.string() }).nullable().default(null),
});

const LIST_TIMEOUT_MS = 6000;
const CACHE_MS = 10 * 60_000;
const MAX_MODELS = 40;

/** A problem the user can act on, shown as written next to the field. */
export class SettingsError extends Error {}

function isAuthFailure(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  const message = err instanceof Error ? err.message : "";
  return status === 401 || status === 403 || /API[ _]KEY/i.test(message);
}

export interface SettingsOptions {
  listModels?: (provider: Provider, key: string) => Promise<string[]>;
  buildEngine?: typeof createEngine;
}

/** Owns which keys exist, where each came from, and which model is active. */
export class SettingsManager {
  private keys: Partial<Record<Provider, string>> = {};
  private selected: { provider: Provider; model: string } | null = null;
  private cache = new Map<Provider, { at: number; key: string; models: string[] }>();
  private built: { id: string; engine: Engine } | null = null;
  private lister: NonNullable<SettingsOptions["listModels"]>;
  private buildEngine: typeof createEngine;
  private warnings: string[];

  constructor(
    private path: string,
    private env: AppConfig,
    options: SettingsOptions = {},
  ) {
    this.lister = options.listModels ?? realListModels;
    this.buildEngine = options.buildEngine ?? createEngine;
    this.warnings = [...env.warnings];
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = FileSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
      for (const provider of PROVIDERS) {
        const key = parsed.keys[provider];
        if (key) this.keys[provider] = key;
      }
      this.selected = parsed.selected;
    } catch {
      this.warnings.push("Saved settings could not be read, so they were ignored.");
    }
  }

  // Written to a temp file first, so a crash cannot leave half a settings file. Owner-only.
  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify({ keys: this.keys, selected: this.selected }, null, 2), { mode: 0o600 });
    renameSync(temp, this.path);
  }

  /** A key added in the app overrides .env. Removing it falls back to .env. */
  private keyFor(provider: Provider): string | undefined {
    return this.keys[provider] ?? this.env.keys[provider];
  }

  active(): { provider: Provider; model: string } | null {
    if (this.selected && this.keyFor(this.selected.provider)) return this.selected;
    const provider =
      this.env.provider && this.keyFor(this.env.provider) ? this.env.provider : PROVIDERS.find((p) => this.keyFor(p));
    if (!provider) return null;
    return { provider, model: this.defaultModel(provider) };
  }

  private defaultModel(provider: Provider): string {
    return provider === this.env.provider && this.env.model ? this.env.model : DEFAULT_MODELS[provider];
  }

  engine(): Engine | null {
    const active = this.active();
    if (!active) return null;
    const apiKey = this.keyFor(active.provider)!;
    const id = `${active.provider}|${active.model}|${apiKey}`;
    if (this.built?.id !== id) {
      const engine = this.buildEngine({ ...active, apiKey, effort: this.env.effort });
      if (!engine) return null;
      this.built = { id, engine };
    }
    return this.built.engine;
  }

  async setKey(provider: Provider, rawKey: string): Promise<{ verified: boolean }> {
    const parsed = KeySchema.safeParse(rawKey);
    if (!parsed.success) throw new SettingsError(`This key ${parsed.error.issues[0].message}.`);
    if (!parsed.data) throw new SettingsError("Paste a key first.");
    const key = parsed.data;

    const detected = providerOfKey(key);
    if (detected && detected !== provider) {
      throw new SettingsError(`This looks like a ${PROVIDER_INFO[detected].label} key. Add it under ${PROVIDER_INFO[detected].label}.`);
    }

    let verified = false;
    try {
      const models = await this.withTimeout(this.lister(provider, key));
      this.cache.set(provider, { at: Date.now(), key, models });
      verified = true;
    } catch (err) {
      if (isAuthFailure(err)) throw new SettingsError(`${PROVIDER_INFO[provider].label} rejected this key.`);
      // A network problem says nothing about the key, so it is kept and checked on first use.
    }

    this.keys[provider] = key;
    this.persist();
    return { verified };
  }

  removeKey(provider: Provider): void {
    if (!this.keys[provider]) throw new SettingsError("This key comes from .env. Remove it from that file.");
    delete this.keys[provider];
    this.cache.delete(provider);
    if (this.selected?.provider === provider && !this.keyFor(provider)) this.selected = null;
    this.persist();
  }

  setModel(provider: Provider, model: string): void {
    if (!this.keyFor(provider)) throw new SettingsError(`Add a ${PROVIDER_INFO[provider].label} key first.`);
    if (!MODEL_PATTERNS[provider].test(model)) throw new SettingsError(`${model} is not a ${PROVIDER_INFO[provider].label} model.`);
    this.selected = { provider, model };
    this.persist();
  }

  private withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), LIST_TIMEOUT_MS);
    });
    return Promise.race([work, limit]).finally(() => clearTimeout(timer));
  }

  /** Fetches live model lists. A failure leaves that provider on its default list. */
  async refreshModels(): Promise<void> {
    await Promise.all(
      PROVIDERS.map(async (provider) => {
        const key = this.keyFor(provider);
        if (!key) return;
        const cached = this.cache.get(provider);
        if (cached && cached.key === key && Date.now() - cached.at < CACHE_MS) return;
        try {
          this.cache.set(provider, { at: Date.now(), key, models: await this.withTimeout(this.lister(provider, key)) });
        } catch {
          // Keep whatever list is already available.
        }
      }),
    );
  }

  private modelsFor(provider: Provider): string[] {
    const active = this.active();
    const first = [active?.provider === provider ? active.model : undefined, this.defaultModel(provider)];
    const listed = this.cache.get(provider)?.models ?? [];
    return [...new Set([...first.filter((m): m is string => Boolean(m)), ...listed])].slice(0, MAX_MODELS);
  }

  /** What the UI may see. Key values never leave this class, only their last four characters. */
  snapshot() {
    const active = this.active();
    return {
      configured: Boolean(active),
      provider: active?.provider ?? null,
      model: active?.model ?? null,
      warnings: this.warnings,
      providers: PROVIDERS.map((id) => {
        const key = this.keyFor(id);
        return {
          id,
          label: PROVIDER_INFO[id].label,
          keyUrl: PROVIDER_INFO[id].keyUrl,
          configured: Boolean(key),
          source: this.keys[id] ? "app" : this.env.keys[id] ? "env" : null,
          inEnv: Boolean(this.env.keys[id]),
          hint: key ? key.slice(-4) : null,
          models: key ? this.modelsFor(id) : [DEFAULT_MODELS[id]],
        };
      }),
    };
  }
}
