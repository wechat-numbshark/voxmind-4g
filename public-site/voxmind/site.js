import { STRINGS } from "./i18n.js";

const LANGS = ["zh", "en", "ja"];

export function currentLang() {
  const hash = location.hash.replace(/^#/, "");
  return LANGS.includes(hash) ? hash : "zh";
}

export function applyLanguage(lang) {
  const pack = STRINGS[lang];
  document.documentElement.lang = lang === "zh" ? "zh-Hans" : lang;
  document.title = pack["meta.title"];
  for (const el of document.querySelectorAll("[data-i18n]")) {
    const value = pack[el.getAttribute("data-i18n")];
    if (value != null) el.textContent = value;
  }
  for (const el of document.querySelectorAll("[data-i18n-alt]")) {
    const value = pack[el.getAttribute("data-i18n-alt")];
    if (value != null) el.alt = value;
  }
  for (const button of document.querySelectorAll("[data-lang]")) {
    const on = button.getAttribute("data-lang") === lang;
    button.setAttribute("aria-pressed", on ? "true" : "false");
  }
  for (const demo of document.querySelectorAll("[data-demo-link]")) {
    demo.hash = lang;
  }
}

function boot() {
  for (const button of document.querySelectorAll("[data-lang]")) {
    button.addEventListener("click", () => {
      location.hash = button.getAttribute("data-lang");
    });
  }
  window.addEventListener("hashchange", () => applyLanguage(currentLang()));
  applyLanguage(currentLang());
}

boot();
