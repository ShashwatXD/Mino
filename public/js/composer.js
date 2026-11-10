const svg = (body) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  send: svg('<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>'),
  stop: svg('<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/>'),
  mic: svg('<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5.5 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v.5"/>'),
  speaker: svg('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>'),
  pin: svg('<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>'),
  trash: svg('<path d="M4 7h16M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7"/>'),
};

let busyShown = null;
function setBusy(busy) {
  if (busy !== busyShown) {
    busyShown = busy;
    send.innerHTML = busy ? ICONS.stop : ICONS.send;
    send.setAttribute("aria-label", busy ? "Stop" : "Send");
  }
  send.disabled = !configured || (!busy && !input.value.trim());
}

const composer = $("composer");
function updateComposer() {
  composer.classList.toggle("expanded", configured && (composer.contains(document.activeElement) || input.value !== ""));
}
function sizeInput() {
  input.style.height = "24px";
  input.style.height = Math.min(input.scrollHeight, 168) + "px";
}
composer.addEventListener("focusin", updateComposer);
composer.addEventListener("focusout", () => setTimeout(updateComposer));
