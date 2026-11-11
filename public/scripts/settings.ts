const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const providerSelect = $<HTMLSelectElement>("provider");
const modelSelect = $<HTMLSelectElement>("model");
const keyInput = $<HTMLInputElement>("key");
const saveButton = $<HTMLButtonElement>("save");
const removeButton = $<HTMLButtonElement>("remove");
const getKey = $<HTMLAnchorElement>("get-key");
const statusText = $("status");
const message = $("message");

// Assigned by the first successful load, before any handler can run.
let data!: SettingsSnapshot;
let saving = false;

async function api(method: string, path: string, body?: unknown): Promise<SettingsSnapshot> {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "Something went wrong.");
  return json;
}

const current = (): ProviderInfo => data.providers.find((p) => p.id === providerSelect.value) ?? data.providers[0];

// Save is only offered when the form differs from what is already saved.
function updateSave(): void {
  const changed = keyInput.value.trim() !== "" || providerSelect.value !== data.provider || modelSelect.value !== data.model;
  saveButton.disabled = saving || !changed;
}

function setMessage(text: string, failed?: boolean): void {
  message.textContent = text;
  message.classList.toggle("failed", Boolean(failed));
}

function fillModels(preferred?: string | null): void {
  const provider = current();
  const wanted = preferred ?? modelSelect.value;
  modelSelect.replaceChildren(...provider.models.map((id) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = id;
    return option;
  }));
  const active = data.provider === provider.id ? data.model : null;
  for (const choice of [wanted, active]) {
    if (choice && provider.models.includes(choice)) { modelSelect.value = choice; break; }
  }
}

function showProvider(preferredModel?: string | null): void {
  const p = current();
  fillModels(preferredModel);
  const where = p.source === "env" ? "Added in .env" : p.inEnv ? "Added here, overrides .env" : "Added here";
  statusText.textContent = p.configured ? where : "Not added";
  statusText.classList.toggle("added", p.configured);
  keyInput.value = "";
  keyInput.placeholder = p.configured ? "Saved key ending in " + p.hint : "Paste your " + p.label + " API key";
  keyInput.setAttribute("aria-label", p.label + " API key");
  getKey.href = p.keyUrl;
  getKey.textContent = "Get a " + p.label + " key";
  removeButton.hidden = p.source !== "app";
  updateSave();
}

function showUsage(): void {
  if (!data.usage) return;
  const { spentUsd, limitUsd, messages, maxMessages } = data.usage;
  $("usage").textContent = `Today: about $${spentUsd.toFixed(2)} of your $${limitUsd.toFixed(2)} limit, ${messages} of ${maxMessages} messages.`;
}

function render(selectActive: boolean): void {
  showUsage();
  if (selectActive) {
    providerSelect.replaceChildren(...data.providers.map((p) => {
      const option = document.createElement("option");
      option.value = p.id;
      option.textContent = p.label;
      return option;
    }));
    providerSelect.value = data.provider ?? "gemini";
  }
  showProvider(selectActive ? data.model : undefined);
  $("warnings").replaceChildren(...(data.warnings || []).map((w) => {
    const p = document.createElement("p");
    p.className = "warn";
    p.textContent = w;
    return p;
  }));
}

providerSelect.addEventListener("change", () => { setMessage(""); showProvider(); });
modelSelect.addEventListener("change", () => { setMessage(""); updateSave(); });
keyInput.addEventListener("input", () => { setMessage(""); updateSave(); });

$("llm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const provider = providerSelect.value;
  const key = keyInput.value.trim();
  const model = modelSelect.value;
  setMessage("");
  if (!key && !current().configured) {
    setMessage("Add an API key for " + current().label + " to use it.", true);
    return;
  }
  saving = true;
  updateSave();
  saveButton.textContent = key ? "Checking key" : "Saving";
  try {
    let verified = true;
    if (key) {
      const added = await api("POST", "/api/settings/key", { provider, key });
      verified = added.verified ?? true;
    }
    data = await api("POST", "/api/settings/model", { provider, model });
    showProvider(model);
    setMessage(verified ? "Saved." : "Saved, but the key could not be verified right now.");
    if (key) refresh();
  } catch (err) {
    setMessage(err instanceof Error ? err.message : "Something went wrong.", true);
  }
  saving = false;
  saveButton.textContent = "Save changes";
  updateSave();
});

removeButton.addEventListener("click", async () => {
  try {
    data = await api("DELETE", "/api/settings/key", { provider: providerSelect.value });
    showProvider();
    setMessage("Key removed.");
  } catch (err) {
    setMessage(err instanceof Error ? err.message : "Something went wrong.", true);
  }
});

// Live model lists arrive after first paint, and must not disturb a key being typed.
async function refresh(): Promise<void> {
  try {
    data = await api("GET", "/api/settings?refresh=1");
    fillModels();
    updateSave();
  } catch {}
}

(async () => {
  try {
    data = await api("GET", "/api/settings");
    render(true);
    refresh();
  } catch {
    setMessage("Could not reach the server. Is it still running?", true);
  }
})();

export {};
