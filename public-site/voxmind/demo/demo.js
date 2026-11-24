import { seed, chrome } from "./seed.js";
import { initialState, reduce } from "./flow.js";

const LANGS = ["zh", "en", "ja"];
let lang = "zh";
let state = initialState();

function currentLang() {
  const hash = location.hash.replace(/^#/, "");
  return LANGS.includes(hash) ? hash : "zh";
}

function text(el, value) {
  el.textContent = value;
}

function render() {
  const ui = chrome[lang];
  document.documentElement.lang = lang === "zh" ? "zh-Hans" : lang;
  document.title = ui.banner + " · VoxMind";
  text(document.querySelector("#banner"), ui.banner);
  text(document.querySelector("#note"), ui.note);
  text(document.querySelector("#device"), ui.device + " · " + seed.deviceId + " · " + ui.synthetic);
  text(document.querySelector("#show"), ui.show);
  text(document.querySelector("#propose"), ui.propose);
  text(document.querySelector("#confirm"), ui.confirm);
  text(document.querySelector("#reset"), ui.reset);
  text(document.querySelector("#home"), ui.home);
  document.querySelector("#home").hash = lang;
  for (const button of document.querySelectorAll("[data-lang]")) {
    button.setAttribute("aria-pressed", button.getAttribute("data-lang") === lang ? "true" : "false");
  }
  document.querySelector("#propose").disabled = state.step === "ready";
  document.querySelector("#confirm").disabled = state.step !== "proposal";

  const speech = document.querySelector("#speech");
  const proposal = document.querySelector("#proposal");
  const record = document.querySelector("#record");
  speech.hidden = !state.speech;
  proposal.hidden = !state.proposal;
  record.hidden = !state.record;
  if (state.speech) {
    text(speech.querySelector(".heading"), ui.speechTitle);
    text(speech.querySelector(".badge"), ui.synthetic);
    text(speech.querySelector("p"), state.speech[lang]);
  }
  if (state.proposal) {
    const item = state.proposal[lang];
    text(proposal.querySelector(".heading"), ui.proposalTitle);
    text(proposal.querySelector(".badge"), ui.synthetic);
    text(proposal.querySelector(".title"), item.title);
    text(proposal.querySelector(".when"), ui.when + " · " + item.when);
    text(proposal.querySelector(".who"), ui.assignee + " · " + item.assignee);
  }
  if (state.record) {
    const item = state.record[lang];
    text(record.querySelector(".heading"), ui.recordTitle);
    text(record.querySelector(".badge"), ui.synthetic);
    text(record.querySelector(".title"), state.record.id + " · " + item.title);
    text(record.querySelector(".state"), item.state);
    text(record.querySelector(".quote"), ui.quote + " · " + state.speech[lang]);
    text(record.querySelector(".feishu"), ui.notFeishu);
  }
}

function act(action) {
  state = reduce(state, action, seed);
  render();
}

for (const button of document.querySelectorAll("[data-lang]")) {
  button.addEventListener("click", () => {
    location.hash = button.getAttribute("data-lang");
  });
}
document.querySelector("#show").addEventListener("click", () => act("show-speech"));
document.querySelector("#propose").addEventListener("click", () => act("propose"));
document.querySelector("#confirm").addEventListener("click", () => act("confirm"));
document.querySelector("#reset").addEventListener("click", () => act("reset"));
window.addEventListener("hashchange", () => {
  lang = currentLang();
  render();
});
lang = currentLang();
render();
