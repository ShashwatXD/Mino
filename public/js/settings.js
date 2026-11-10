const $ = (id) => document.getElementById(id);
let data = null;
let saving = false;

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "Something went wrong.");
  return json;
}

const current = () => data.providers.find((p) => p.id === $("provider").value);

// Save is only offered when the form differs from what is already saved.
function updateSave() {
  const changed = $("key").value.trim() !== "" || $("provider").value !== data.provider || $("model").value !== data.model;
  $("save").disabled = saving || !changed;
}

function setMessage(text, failed) {
  $("message").textContent = text;
  $("message").classList.toggle("failed", Boolean(failed));
}

function fillModels(preferred) {
  const provider = current();
  const select = $("model");
  const wanted = preferred ?? select.value;
  select.replaceChildren(...provider.models.map((id) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = id;
    return option;
  }));
  const active = data.provider === provider.id ? data.model : null;
  for (const choice of [wanted, active]) {
    if (choice && provider.models.includes(choice)) { select.value = choice; break; }
  }
}

function showProvider(preferredModel) {
  const p = current();
  fillModels(preferredModel);
  const where = p.source === "env" ? "Added in .env" : p.inEnv ? "Added here, overrides .env" : "Added here";
  $("status").textContent = p.configured ? where : "Not added";
  $("status").classList.toggle("added", p.configured);
  $("key").value = "";
  $("key").placeholder = p.configured ? "Saved key ending in " + p.hint : "Paste your " + p.label + " API key";
  $("key").setAttribute("aria-label", p.label + " API key");
  $("get-key").href = p.keyUrl;
  $("get-key").textContent = "Get a " + p.label + " key";
  $("remove").hidden = p.source !== "app";
  updateSave();
}

function showUsage() {
  if (!data.usage) return;
  const { spentUsd, limitUsd, messages, maxMessages } = data.usage;
  $("usage").textContent = `Today: about $${spentUsd.toFixed(2)} of your $${limitUsd.toFixed(2)} limit, ${messages} of ${maxMessages} messages.`;
}

function render(selectActive) {
  showUsage();
  if (selectActive) {
    $("provider").replaceChildren(...data.providers.map((p) => {
      const option = document.createElement("option");
      option.value = p.id;
      option.textContent = p.label;
      return option;
    }));
    $("provider").value = data.provider ?? "gemini";
  }
  showProvider(selectActive ? data.model : undefined);
  $("warnings").replaceChildren(...(data.warnings || []).map((w) => {
    const p = document.createElement("p");
    p.className = "warn";
    p.textContent = w;
    return p;
  }));
}

$("provider").addEventListener("change", () => { setMessage(""); showProvider(); });
$("model").addEventListener("change", () => { setMessage(""); updateSave(); });
$("key").addEventListener("input", () => { setMessage(""); updateSave(); });

$("llm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const provider = $("provider").value;
  const key = $("key").value.trim();
  const model = $("model").value;
  const save = $("save");
  setMessage("");
  if (!key && !current().configured) {
    setMessage("Add an API key for " + current().label + " to use it.", true);
    return;
  }
  saving = true;
  updateSave();
  save.textContent = key ? "Checking key" : "Saving";
  try {
    let verified = true;
    if (key) {
      const added = await api("POST", "/api/settings/key", { provider, key });
      verified = added.verified;
    }
    data = await api("POST", "/api/settings/model", { provider, model });
    showProvider(model);
    setMessage(verified ? "Saved." : "Saved, but the key could not be verified right now.");
    if (key) refresh();
  } catch (err) {
    setMessage(err.message, true);
  }
  saving = false;
  save.textContent = "Save changes";
  updateSave();
});

$("remove").addEventListener("click", async () => {
  try {
    data = await api("DELETE", "/api/settings/key", { provider: $("provider").value });
    showProvider();
    setMessage("Key removed.");
  } catch (err) {
    setMessage(err.message, true);
  }
});

// Live model lists arrive after first paint, and must not disturb a key being typed.
async function refresh() {
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
