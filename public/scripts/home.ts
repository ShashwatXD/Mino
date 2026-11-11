let typing = 0;

/** Types the title one letter at a time. Screen readers get the whole text at once. */
function typeTitle(node: HTMLElement, text: string, done?: () => void): void {
  const run = ++typing;
  node.setAttribute("aria-label", text);
  const shown = el("span");
  shown.setAttribute("aria-hidden", "true");
  const caret = el("span", "caret");
  caret.setAttribute("aria-hidden", "true");
  node.replaceChildren(shown, caret);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { shown.textContent = text; done?.(); return; }
  let i = 0;
  const step = () => {
    if (run !== typing) return;
    shown.textContent = text.slice(0, ++i);
    if (i < text.length) setTimeout(step, 70);
    else done?.();
  };
  setTimeout(step, 200);
}

const CAT = `<svg viewBox="0 0 60 100" aria-hidden="true">
  <path class="cat-body" d="M19 18 17 4.5l10.5 8ZM41 18l2-13.5-10.5 8Z"/>
  <circle class="cat-body" cx="30" cy="23" r="13"/>
  <path class="cat-body" d="M30 31C15 34 11 57 14 70h32c3-13-1-36-16-39Z"/>
  <ellipse class="cat-body" cx="23.5" cy="71" rx="4.6" ry="3"/>
  <ellipse class="cat-body" cx="36.5" cy="71" rx="4.6" ry="3"/>
  <path class="cat-tail" d="M44 64c11 0 13 11 9 21-2.5 7-.5 12 3 13"/>
  <g class="cat-eyes"><ellipse cx="25" cy="23" rx="1.7" ry="2.4"/><ellipse cx="35" cy="23" rx="1.7" ry="2.4"/></g>
</svg>`;
// Where the cat's seat sits in its drawing, and how tall it sits against the letter it is on.
const CAT_SEAT = 0.7;
const CAT_SIZE = 0.62;

/**
 * Seats the cat on the last N of the title. The letter's real top is measured from the font
 * (canvas cap height above a baseline marker), so the cat rests on the glyph at any size.
 */
function perchCat(title: HTMLElement): void {
  const shown = title.querySelector("span[aria-hidden]");
  const text = shown?.textContent ?? "";
  const at = text.toLowerCase().lastIndexOf("n");
  if (!shown || at < 0) return;
  const baseline = el("span", "baseline");
  const letter = el("span", "", text[at]);
  shown.replaceChildren(text.slice(0, at), baseline, letter, text.slice(at + 1));
  const cat = el("div", "cat");
  cat.innerHTML = CAT;
  title.append(cat);

  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return;
  const place = () => {
    if (!cat.isConnected) { removeEventListener("resize", place); return; }
    const style = getComputedStyle(title);
    ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const glyph = ctx.measureText(text[at].toUpperCase());
    const box = title.getBoundingClientRect();
    const start = letter.getBoundingClientRect().left;
    const height = (glyph.actualBoundingBoxAscent * CAT_SIZE) / CAT_SEAT;
    const width = height * 0.6;
    const capTop = baseline.getBoundingClientRect().top - glyph.actualBoundingBoxAscent;
    const centre = start + (glyph.actualBoundingBoxRight - glyph.actualBoundingBoxLeft) / 2;
    Object.assign(cat.style, {
      width: `${width}px`,
      height: `${height}px`,
      left: `${centre - width / 2 - box.left}px`,
      top: `${capTop - height * CAT_SEAT - box.top}px`,
    });
  };
  place();
  document.fonts?.ready.then(place);
  addEventListener("resize", place);
}

function syncTemporary() {
  $("temporary").setAttribute("aria-pressed", String(temporary));
  document.body.classList.toggle("is-temporary", temporary);
}

function showEmpty() {
  lastDay = null;
  syncTemporary();
  messages.replaceChildren();
  const hero = el("section", configured ? "hero centered" : "hero compact");
  const title = el("h1");
  const heading = temporary ? "Temporary chat." : "Ask anything.";
  hero.append(title);
  if (configured) {
    document.body.classList.add("is-empty");
    typeTitle(title, heading, () => { if (!temporary) perchCat(title); });
  } else {
    document.body.classList.remove("is-empty");
    title.textContent = heading;
  }
  if (temporary) hero.append(el("p", "temporary-note", "Not saved to your chats. Mino won't look at or add to its memory."));

  if (!configured) hero.append(setupCard());
  messages.append(hero);
}

function copyText(text: string): Promise<void> {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  const area = el("textarea");
  area.value = text;
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
  return Promise.resolve();
}

function setupCard(): HTMLElement {
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
