let statusWarnings = [];

let settingsData = null;
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

function fillModels(select, withManage) {
  select.replaceChildren();
  for (const provider of settingsData.providers) {
    if (!provider.configured) continue;
    const group = document.createElement("optgroup");
    group.label = provider.label;
    for (const model of provider.models) {
      const option = el("option", "", model);
      option.value = provider.id + "|" + model;
      option.selected = provider.id === settingsData.provider && model === settingsData.model;
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
function fitSelect(select) {
  const probe = el("span", select.className, select.options[select.selectedIndex]?.text ?? "");
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;padding:0;margin:0;background:none";
  document.body.append(probe);
  select.style.width = Math.ceil(probe.getBoundingClientRect().width) + 20 + "px";
  probe.remove();
}

function applySettings(data) {
  const was = configured;
  settingsData = data;
  configured = data.configured;
  statusWarnings = data.warnings || [];
  input.disabled = !configured;
  input.placeholder = configured ? "Ask anything" : "Add an API key to start chatting";
  $("model").hidden = !configured;
  if (configured) { fillModels($("model"), true); fitSelect($("model")); }
  setBusy(Boolean(active));
  updateComposer();
  if (was !== configured && messages.querySelector(".hero")) showEmpty();
}

async function chooseModel(value) {
  const at = value.indexOf("|");
  try {
    applySettings(await api("POST", "/api/settings/model", { provider: value.slice(0, at), model: value.slice(at + 1) }));
  } catch {
    applySettings(settingsData);
  }
}

async function refreshModels() {
  try { applySettings(await api("GET", "/api/settings?refresh=1")); } catch {}
}

$("model").addEventListener("change", (e) => {
  if (e.target.value === "manage") { location.href = "/settings"; return; }
  chooseModel(e.target.value);
});
