import { existsSync, readFileSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const FILES: Record<string, [string, string]> = {
  "/": ["public/index.html", "text/html; charset=utf-8"],
  "/settings": ["public/settings.html", "text/html; charset=utf-8"],
  "/traces": ["public/traces.html", "text/html; charset=utf-8"],
  "/styles.css": ["public/styles.css", "text/css; charset=utf-8"],
  "/vendor/marked.js": ["node_modules/marked/marked.min.js", "text/javascript; charset=utf-8"],
  "/vendor/purify.js": ["node_modules/dompurify/dist/purify.min.js", "text/javascript; charset=utf-8"],
};

const SCRIPT = /^\/js\/([a-z-]+)\.js$/;
const compiled = new Map<string, { mtime: number; code: string }>();

/** The page's scripts are written in TypeScript. Node strips the types on request, so there is no build step. */
function pageScript(name: string): string | null {
  const path = join(ROOT, "public", "scripts", `${name}.ts`);
  if (!existsSync(path)) return null;
  const mtime = statSync(path).mtimeMs;
  const cached = compiled.get(path);
  if (cached?.mtime === mtime) return cached.code;
  const code = stripTypeScriptTypes(readFileSync(path, "utf8"));
  compiled.set(path, { mtime, code });
  return code;
}

/** Only listed paths and the page's own scripts are served, so no request can reach any other file. */
export function serveStatic(res: ServerResponse, pathname: string): void {
  const script = pathname.match(SCRIPT);
  const code = script ? pageScript(script[1]) : null;
  if (code !== null) {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
    res.end(code);
    return;
  }
  const file = FILES[pathname];
  if (!file) {
    res.writeHead(404).end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": file[1] });
  res.end(readFileSync(join(ROOT, file[0])));
}
