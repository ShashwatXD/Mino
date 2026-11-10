import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/server.ts";
import { SettingsManager } from "../src/settings.ts";
import { Store } from "../src/store.ts";

const GEMINI = "AIzaSyA1234567890abcdefghijklmnopqrstuv";
const OTHER_GEMINI = "AIzaSyZ0987654321zyxwvutsrqponmlkjihgfe";
const CLAUDE = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
const OPENAI = "sk-proj-abcdefghijklmnopqrstuvwxyz";

const path = () => join(mkdtempSync(join(tmpdir(), "mino-")), "settings.json");
const lists = async (provider: string) => (provider === "gemini" ? ["gemini-3.8-flash", "gemini-3.6-flash"] : ["claude-sonnet-5-5"]);
const manager = (env: Record<string, string> = {}, file = path(), listModels: any = lists) =>
  new SettingsManager(file, loadConfig(env), { listModels, buildEngine: (c) => ({ provider: c.provider!, model: c.model!, run: async () => ({ text: "", sources: [], queries: [], stopReason: null }) }) });

test("a key from .env is reported as coming from .env", () => {
  const s = manager({ GEMINI_API_KEY: GEMINI }).snapshot();
  const gemini = s.providers.find((p) => p.id === "gemini")!;
  assert.equal(s.configured, true);
  assert.equal(gemini.source, "env");
  assert.equal(s.providers.find((p) => p.id === "openai")!.source, null);
});

test("the snapshot never contains a key", () => {
  const m = manager({ GEMINI_API_KEY: GEMINI });
  const json = JSON.stringify(m.snapshot());
  assert.equal(json.includes(GEMINI), false);
  assert.equal(m.snapshot().providers[0].hint, GEMINI.slice(-4));
});

test("a key added in the app turns on the engine and persists privately", async () => {
  const file = path();
  const m = manager({}, file);
  assert.equal(m.snapshot().configured, false);
  assert.equal(m.engine(), null);
  assert.deepEqual(await m.setKey("anthropic", CLAUDE), { verified: true });
  assert.equal(m.active()?.provider, "anthropic");
  assert.equal(m.engine()?.provider, "anthropic");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(manager({}, file).snapshot().providers.find((p) => p.id === "anthropic")!.source, "app");
});

test("an app key overrides .env, and removing it falls back", async () => {
  const m = manager({ GEMINI_API_KEY: GEMINI });
  await m.setKey("gemini", OTHER_GEMINI);
  assert.equal(m.snapshot().providers[0].source, "app");
  assert.equal(m.snapshot().providers[0].inEnv, true);
  m.removeKey("gemini");
  assert.equal(m.snapshot().providers[0].source, "env");
  assert.equal(m.snapshot().configured, true);
});

test("a .env key cannot be removed from the app", () => {
  assert.throws(() => manager({ GEMINI_API_KEY: GEMINI }).removeKey("gemini"), /\.env/);
});

test("a key for the wrong provider is refused with where it belongs", async () => {
  await assert.rejects(manager().setKey("gemini", CLAUDE), /Add it under Claude/);
});

test("a key the provider rejects is not saved", async () => {
  const file = path();
  const reject = async () => {
    throw Object.assign(new Error("nope"), { status: 401 });
  };
  await assert.rejects(manager({}, file, reject).setKey("gemini", GEMINI), /rejected/);
  assert.equal(existsSync(file), false);
});

test("a network failure keeps the key but marks it unverified", async () => {
  const offline = async () => {
    throw new TypeError("fetch failed");
  };
  const m = manager({}, path(), offline);
  assert.deepEqual(await m.setKey("gemini", GEMINI), { verified: false });
  assert.equal(m.snapshot().configured, true);
});

test("placeholders and blanks are refused", async () => {
  await assert.rejects(manager().setKey("gemini", "your_key_here_please_replace"), /placeholder/);
  await assert.rejects(manager().setKey("gemini", "   "), /Paste a key/);
});

test("Gemini stays the default when several keys are added", async () => {
  const m = manager();
  await m.setKey("anthropic", CLAUDE);
  await m.setKey("gemini", GEMINI);
  assert.equal(m.active()?.provider, "gemini");
  assert.equal(m.active()?.model, "gemini-3.1-flash-lite");
});

test("the chosen model survives a restart and switches the engine", async () => {
  const file = path();
  const m = manager({ GEMINI_API_KEY: GEMINI, OPENAI_API_KEY: OPENAI }, file);
  m.setModel("openai", "gpt-6-astra");
  assert.equal(m.engine()?.provider, "openai");
  assert.deepEqual(manager({ GEMINI_API_KEY: GEMINI, OPENAI_API_KEY: OPENAI }, file).active(), { provider: "openai", model: "gpt-6-astra" });
});

test("a model needs a key and must belong to its provider", () => {
  const m = manager({ GEMINI_API_KEY: GEMINI });
  assert.throws(() => m.setModel("openai", "gpt-6-astra"), /key first/);
  assert.throws(() => m.setModel("gemini", "claude-opus-5-5"), /not a Gemini model/);
});

test("removing the selected provider's key returns to a working default", async () => {
  const m = manager({ GEMINI_API_KEY: GEMINI });
  await m.setKey("anthropic", CLAUDE);
  m.setModel("anthropic", "claude-sonnet-5-5");
  m.removeKey("anthropic");
  assert.equal(m.active()?.provider, "gemini");
});

test("live model lists reach the selector, with the active model first", async () => {
  const m = manager({ GEMINI_API_KEY: GEMINI });
  await m.refreshModels();
  m.setModel("gemini", "gemini-3.6-flash");
  assert.deepEqual(m.snapshot().providers[0].models, ["gemini-3.6-flash", "gemini-3.1-flash-lite", "gemini-3.8-flash"]);
});

test("a corrupt settings file is ignored with a warning", () => {
  const file = path();
  writeFileSync(file, "{not json");
  const s = manager({ GEMINI_API_KEY: GEMINI }, file).snapshot();
  assert.equal(s.configured, true);
  assert.match(s.warnings[0], /could not be read/);
});

const servers: Server[] = [];
after(() =>
  servers.forEach((s) => {
    s.closeAllConnections();
    s.close();
  }),
);

async function api() {
  const settings = manager();
  const server = createServer(createApp({ store: new Store(":memory:"), settings, run: async () => ({ text: "", sources: [], queries: [], stopReason: null }) }));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("the API adds a key and never returns it", async () => {
  const base = await api();
  const res = await fetch(`${base}/api/settings/key`, { method: "POST", body: JSON.stringify({ provider: "gemini", key: GEMINI }) });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(text.includes(GEMINI), false);
  assert.equal(JSON.parse(text).configured, true);
});

test("the API explains a bad key and validates its input", async () => {
  const base = await api();
  const wrong = await fetch(`${base}/api/settings/key`, { method: "POST", body: JSON.stringify({ provider: "gemini", key: CLAUDE }) });
  assert.equal(wrong.status, 400);
  assert.match((await wrong.json()).error, /Claude/);
  const invalid = await fetch(`${base}/api/settings/key`, { method: "POST", body: JSON.stringify({ provider: "llama", key: "x" }) });
  assert.equal(invalid.status, 400);
});

test("other websites cannot call the local API", async () => {
  const base = await api();
  const res = await fetch(`${base}/api/settings/key`, {
    method: "POST",
    headers: { Origin: "https://evil.example" },
    body: JSON.stringify({ provider: "gemini", key: GEMINI }),
  });
  assert.equal(res.status, 403);
  assert.equal(readFileSync(new URL(import.meta.url)).length > 0, true);
});
