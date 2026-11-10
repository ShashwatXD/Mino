import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { RemoveKeySchema, SetKeySchema, SetModelSchema, SettingsError, type SettingsManager } from "../../services/settings.ts";
import type { SpendGuard } from "../../services/spend-guard.ts";
import { readBody, sendJson } from "../request.ts";

export async function handleSettings(req: IncomingMessage, res: ServerResponse, url: URL, settings: SettingsManager, guard?: SpendGuard): Promise<void> {
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === "GET /api/settings") {
      if (url.searchParams.has("refresh")) await settings.refreshModels();
      sendJson(res, 200, { ...settings.snapshot(), usage: guard?.status() });
      return;
    }
    const json: unknown = JSON.parse((await readBody(req)) || "null");
    let verified: boolean | undefined;
    if (route === "POST /api/settings/key") {
      const body = SetKeySchema.parse(json);
      verified = (await settings.setKey(body.provider, body.key)).verified;
    } else if (route === "DELETE /api/settings/key") {
      settings.removeKey(RemoveKeySchema.parse(json).provider);
    } else if (route === "POST /api/settings/model") {
      const body = SetModelSchema.parse(json);
      settings.setModel(body.provider, body.model);
    } else {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    sendJson(res, 200, { ...settings.snapshot(), usage: guard?.status(), verified });
  } catch (err) {
    if (err instanceof SettingsError) sendJson(res, 400, { error: err.message });
    else if (err instanceof z.ZodError || err instanceof SyntaxError) sendJson(res, 400, { error: "Invalid request" });
    else throw err;
  }
}
