let statusWarnings: string[] = [];

let settingsData: SettingsSnapshot | null = null;
async function api<T = SettingsSnapshot>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

function fillModels(select: HTMLSelectElement, withManage: boolean, data: SettingsSnapshot): void {
  select.replaceChildren();
  for (const provider of data.providers) {
    if (!provider.configured) continue;
    const group = document.createElement("optgroup");
    group.label = provider.label;
    for (const model of provider.models) {
      const option = el("option", "", model);
      option.value = provider.id + "|" + model;
      option.selected = provider.id === data.provider && model === data.model;
      group.append(option);
    }
    select.append(group);
  }
  if (withManage) {
    const option = el("option", "", "Add or manage keys…");
    option.value = "manage";
    select.append(option);
  }
}

/** A native select is as wide as its longest option, so it is sized to the chosen one instead. */
function fitSelect(select: HTMLSelectElement): void {
  const probe = el("span", select.className, select.options[select.selectedIndex]?.text ?? "");
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;padding:0;margin:0;background:none";
  document.body.append(probe);
  select.style.width = Math.ceil(probe.getBoundingClientRect().width) + 20 + "px";
  probe.remove();
}

function applySettings(data: SettingsSnapshot): void {
  const was = configured;
  settingsData = data;
  configured = data.configured;
  statusWarnings = data.warnings || [];
  input.disabled = !configured;
  input.placeholder = configured ? "Ask anything" : "Add an API key to start chatting";
  $("model").hidden = !configured;
  const select = $<HTMLSelectElement>("model");
  if (configured) { fillModels(select, true, data); fitSelect(select); }
  setBusy(Boolean(active));
  updateComposer();
  if (was !== configured && messages.querySelector(".hero")) showEmpty();
}

async function chooseModel(value: string): Promise<void> {
  const at = value.indexOf("|");
  try {
    applySettings(await api("POST", "/api/settings/model", { provider: value.slice(0, at), model: value.slice(at + 1) }));
  } catch {
    if (settingsData) applySettings(settingsData);
  }
}

async function refreshModels() {
  try { applySettings(await api("GET", "/api/settings?refresh=1")); } catch {}
}

$<HTMLSelectElement>("model").addEventListener("change", (e) => {
  const value = (e.target as HTMLSelectElement).value;
  if (value === "manage") { location.href = "/settings"; return; }
  chooseModel(value);
});
