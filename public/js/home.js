let typing = 0;

/** Types the title one letter at a time. Screen readers get the whole text at once. */
function typeTitle(node, text) {
  const run = ++typing;
  node.setAttribute("aria-label", text);
  const shown = el("span");
  shown.setAttribute("aria-hidden", "true");
  const caret = el("span", "caret");
  caret.setAttribute("aria-hidden", "true");
  node.replaceChildren(shown, caret);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { shown.textContent = text; return; }
  let i = 0;
  const step = () => {
    if (run !== typing) return;
    shown.textContent = text.slice(0, ++i);
    if (i < text.length) setTimeout(step, 70);
  };
  setTimeout(step, 200);
}

function showEmpty() {
  lastDay = null;
  messages.replaceChildren();
  const hero = el("section", configured ? "hero centered" : "hero compact");
  const title = el("h1");
  hero.append(title);
  if (configured) {
    document.body.classList.add("is-empty");
    typeTitle(title, "Ask anything.");
  } else {
    document.body.classList.remove("is-empty");
    title.textContent = "Ask anything.";
  }

  if (!configured) hero.append(setupCard());
  messages.append(hero);
}

function copyText(text) {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  const area = el("textarea");
  area.value = text;
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
  return Promise.resolve();
}

function setupCard() {
  const card = el("div", "setup");
  card.append(el("div", "mono", "One step left"), el("h2", "", "API key not configured"));
  card.append(el("div", "", "Mino runs on a Gemini, Claude or OpenAI key. One is enough."));
  const add = el("a", "primary", "Add API key");
  add.href = "/settings";
  card.append(add, el("div", "mono or", "Or press Ctrl+C in your terminal and run"));

  const box = el("div", "command");
  const copy = el("button", "mono copy", "Copy");
  copy.type = "button";
  copy.addEventListener("click", () => {
    copyText(SETUP_COMMAND).then(() => {
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy"; }, 1600);
    }).catch(() => { copy.textContent = "Press Cmd+C"; });
  });
  box.append(el("code", "", SETUP_COMMAND), copy);
  card.append(box);

  const other = el("p", "aside");
  other.append("Using Claude or OpenAI? Swap in ", el("code", "", "ANTHROPIC_API_KEY"), " or ", el("code", "", "OPENAI_API_KEY"), ".");
  card.append(other);
  for (const warning of statusWarnings) card.append(el("p", "warn", warning));
  return card;
}
