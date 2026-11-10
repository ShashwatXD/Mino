import { existsSync, readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const FILES: Record<string, [string, string]> = {
  "/": ["public/index.html", "text/html; charset=utf-8"],
  "/settings": ["public/settings.html", "text/html; charset=utf-8"],
  "/styles.css": ["public/styles.css", "text/css; charset=utf-8"],
  "/vendor/marked.js": ["node_modules/marked/marked.min.js", "text/javascript; charset=utf-8"],
  "/vendor/purify.js": ["node_modules/dompurify/dist/purify.min.js", "text/javascript; charset=utf-8"],
};

const SCRIPT = /^\/js\/[a-z-]+\.js$/;

/** Only listed paths and the page's own scripts are served, so no request can reach any other file. */
export function serveStatic(res: ServerResponse, pathname: string): void {
  const file = FILES[pathname] ?? (SCRIPT.test(pathname) ? [`public${pathname}`, "text/javascript; charset=utf-8"] : undefined);
  if (!file || !existsSync(join(ROOT, file[0]))) {
    res.writeHead(404).end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": file[1] });
  res.end(readFileSync(join(ROOT, file[0])));
}
