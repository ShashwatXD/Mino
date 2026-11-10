import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { ConfigError, loadConfig } from "./config/config.ts";
import { createRepositories } from "./db/repositories/index.ts";
import { createApp } from "./http/app.ts";
import { ROOT } from "./http/static.ts";
import { NoEngineError } from "./services/errors.ts";
import { SettingsManager } from "./services/settings.ts";
import { SpendGuard } from "./services/spend-guard.ts";

if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(err.message);
  process.exit(1);
}
for (const warning of config.warnings) console.warn(warning);

const settings = new SettingsManager(join(ROOT, "data", "settings.json"), config);
const active = settings.active();
if (active) console.log(`Engine: ${active.provider} (${active.model})`);
else console.warn("No API key yet. Add one in the app or in .env.");

const store = createRepositories(join(ROOT, "data", "memory.db"));
store.turns.recoverInterrupted();

const app = createApp({
  store,
  settings,
  guard: new SpendGuard(store.usage, config.limits),
  currentModel: () => settings.active()?.model ?? "unknown",
  helpers: () => settings.helpers(),
  run: (options) => settings.engine()?.run(options) ?? Promise.reject(new NoEngineError()),
});

createServer(app).listen(config.port, "127.0.0.1", () => console.log(`Chat agent running at http://localhost:${config.port}`));
