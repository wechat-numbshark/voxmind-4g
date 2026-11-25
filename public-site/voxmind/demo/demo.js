import { seed, scenarios, chrome } from "./seed.js";
import { initialState, reduce } from "./flow.js";

const LANGS = ["zh", "en", "ja", "es", "de"];
let lang = "zh";
let scenarioKey = "feishu";
let state = initialState();

function currentLang() {
  const hash = location.hash.replace(/^#/, "");
  return LANGS.includes(hash) ? hash : "zh";
}

function activeScenario() {
  return scenarios[scenarioKey] || scenarios.feishu;
}

function text(el, value) {
  if (el) el.textContent = value;
}

function render() {
  const ui = chrome[lang] || chrome.zh;
  const sc = activeScenario();
  document.documentElement.lang = lang === "zh" ? "zh-Hans" : lang;
  document.title = ui.banner + " · VoxMind";
  text(document.querySelector("#banner"), ui.banner);
  text(document.querySelector("#note"), ui.note);
  text(document.querySelector("#device"), ui.device + " · " + seed.deviceId + " · " + ui.synthetic);
  text(document.querySelector("#tel-net"), ui.telNet);
  text(document.querySelector("#tel-bat"), ui.telBat);
  text(document.querySelector("#tel-fw"), ui.telFw);
  text(document.querySelector("#sc-label"), ui.scLabel);
  text(document.querySelector("#tab-feishu"), ui.tabFeishu);
  text(document.querySelector("#tab-expense"), ui.tabExpense);
  text(document.querySelector("#tab-smarthome"), ui.tabSmartHome);
  text(document.querySelector("#show"), ui.show);
  text(document.querySelector("#propose"), ui.propose);
  text(document.querySelector("#confirm"), ui.confirm);
  text(document.querySelector("#reset"), ui.reset);
  text(document.querySelector("#home"), ui.home);
  document.querySelector("#home").hash = lang;

  for (const button of document.querySelectorAll("[data-lang]")) {
    button.setAttribute("aria-pressed", button.getAttribute("data-lang") === lang ? "true" : "false");
  }
  for (const tab of document.querySelectorAll("[data-scenario]")) {
    tab.setAttribute("aria-selected", tab.getAttribute("data-scenario") === scenarioKey ? "true" : "false");
  }

  document.querySelector("#show").disabled = state.step !== "ready";
  document.querySelector("#propose").disabled = state.step !== "speech";
  document.querySelector("#confirm").disabled = state.step !== "proposal";

  const screenStatus = document.querySelector("#screen-status");
  const screenTitle = document.querySelector("#screen-title");
  const screenSub = document.querySelector("#screen-sub");
  if (state.step === "ready") {
    text(screenStatus, ui.screenReady);
    text(screenTitle, sc.proposal[lang].channel);
    text(screenSub, ui.show);
  } else if (state.step === "speech") {
    text(screenStatus, ui.screenSpeech);
    text(screenTitle, ui.speechTitle);
    text(screenSub, state.speech[lang]);
  } else if (state.step === "proposal") {
    text(screenStatus, ui.screenProposal);
    text(screenTitle, state.proposal[lang].title);
    text(screenSub, state.proposal[lang].when + " · " + state.proposal[lang].assignee);
  } else if (state.step === "recorded") {
    text(screenStatus, ui.screenRecorded);
    text(screenTitle, state.record.id + " · " + state.record[lang].title);
    text(screenSub, state.record[lang].state);
  }

  const speech = document.querySelector("#speech");
  const proposal = document.querySelector("#proposal");
  const record = document.querySelector("#record");
  speech.hidden = !state.speech;
  proposal.hidden = !state.proposal;
  record.hidden = !state.record;

  if (state.speech) {
    text(speech.querySelector(".heading"), ui.speechTitle);
    text(speech.querySelector(".badge"), ui.synthetic);
    text(speech.querySelector(".quote-text"), state.speech[lang]);
  }
  if (state.proposal) {
    const item = state.proposal[lang];
    text(proposal.querySelector(".heading"), ui.proposalTitle);
    text(proposal.querySelector(".badge"), ui.synthetic);
    text(proposal.querySelector(".title"), item.title);
    text(proposal.querySelector(".when"), ui.when + " · " + item.when);
    text(proposal.querySelector(".who"), ui.assignee + " · " + item.assignee);
    text(proposal.querySelector(".channel"), ui.channel + " · " + item.channel);
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
  state = reduce(state, action, activeScenario());
  render();
}

for (const button of document.querySelectorAll("[data-lang]")) {
  button.addEventListener("click", () => {
    location.hash = button.getAttribute("data-lang");
  });
}
for (const tab of document.querySelectorAll("[data-scenario]")) {
  tab.addEventListener("click", () => {
    scenarioKey = tab.getAttribute("data-scenario");
    state = initialState();
    render();
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
