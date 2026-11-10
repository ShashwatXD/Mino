// Dictation, using the browser's own speech recognition.
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const mic = $("mic");
let listening = null;
$("wave").replaceChildren(...Array.from({ length: 120 }, (_, i) => {
  const bar = el("i");
  bar.style.animationDelay = `${-((i * 7) % 11) / 10}s`;
  bar.style.animationDuration = `${0.7 + ((i * 5) % 7) / 10}s`;
  return bar;
}));

function endListening() {
  listening = null;
  composer.classList.remove("listening");
  mic.innerHTML = ICONS.mic;
  mic.setAttribute("aria-label", "Speak your message");
  sizeInput();
  setBusy(Boolean(active));
  input.focus();
  updateComposer();
}

function startListening() {
  const session = new Recognition();
  const base = input.value.trim();
  session.continuous = true;
  session.interimResults = true;
  session.lang = navigator.language || "en-US";
  session.onresult = (e) => {
    const said = Array.from(e.results, (r) => r[0].transcript).join("");
    input.value = base ? base + " " + said.trim() : said.trim();
  };
  session.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      mic.hidden = true;
      input.placeholder = "Microphone access is blocked";
    }
  };
  session.onend = () => { if (listening === session) endListening(); };
  listening = session;
  composer.classList.add("listening");
  mic.innerHTML = ICONS.check;
  mic.setAttribute("aria-label", "Finish speaking");
  session.start();
}

if (Recognition) {
  mic.hidden = false;
  mic.innerHTML = ICONS.mic;
  mic.addEventListener("click", () => { if (listening) listening.stop(); else startListening(); });
}

// Read aloud, using the browser's own voices.
const synth = window.speechSynthesis;
let speaking = null;

function stopSpeaking() {
  if (!speaking) return;
  speaking.classList.remove("on");
  speaking = null;
  synth.cancel();
}

function speak(text, button) {
  if (speaking === button) { stopSpeaking(); return; }
  stopSpeaking();
  speaking = button;
  button.classList.add("on");
  // Long utterances get cut off by some voices, so sentences are queued in short pieces.
  const pieces = (text.match(/[^.!?\n]+[.!?]*\s*/g) || [text]).reduce((all, sentence) => {
    if (all.length && all.at(-1).length + sentence.length < 220) all[all.length - 1] += sentence;
    else all.push(sentence);
    return all;
  }, []);
  pieces.forEach((piece, i) => {
    const utterance = new SpeechSynthesisUtterance(piece);
    if (i === pieces.length - 1) utterance.onend = () => {
      if (speaking === button) { button.classList.remove("on"); speaking = null; }
    };
    synth.speak(utterance);
  });
}

function toolButton(icon, label) {
  const button = el("button", "round");
  button.type = "button";
  button.innerHTML = icon;
  button.setAttribute("aria-label", label);
  button.title = label;
  return button;
}

function addAnswerTools(view, text) {
  const tools = el("div", "answer-tools");
  const copy = toolButton(ICONS.copy, "Copy");
  copy.addEventListener("click", () => {
    copyText(text).then(() => {
      copy.innerHTML = ICONS.check;
      copy.title = "Copied";
      setTimeout(() => { copy.innerHTML = ICONS.copy; copy.title = "Copy"; }, 1500);
    }).catch(() => {});
  });
  tools.append(copy);
  if (synth) {
    const read = toolButton(ICONS.speaker, "Read aloud");
    read.addEventListener("click", () => speak(view.answer.innerText, read));
    tools.append(read);
  }
  view.wrap.append(tools);
}
