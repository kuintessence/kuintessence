import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import cpEn from "../locales/cp/en.json";
import cpZh from "../locales/cp/zh.json";
import en from "../locales/en.json";
import wfEditorEn from "../locales/workflow-editor.en.json";
import wfEditorZh from "../locales/workflow-editor.zh.json";
import zh from "../locales/zh.json";

export const SUPPORTED_LANGS = ["zh", "en"] as const;
export type Lang = (typeof SUPPORTED_LANGS)[number];
const STORAGE_KEY = "kq.lang";

function detectLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "zh" || stored === "en") return stored;
  } catch {
    // ignore
  }
  const nav = navigator.language.toLowerCase();
  return nav.startsWith("zh") ? "zh" : "en";
}

// Merge feature namespaces into the default `translation` bundle. We keep a
// single bundle for backwards compatibility with existing keys (e.g. `nav.*`,
// `dashboard.*`) while feature-scoped keys live under their own top-level
// prefix such as `cp.*` and `workflow.editor.*`.
const enMerged = { ...en, ...cpEn, ...wfEditorEn };
const zhMerged = { ...zh, ...cpZh, ...wfEditorZh };

i18n.use(initReactI18next).init({
  resources: { zh: { translation: zhMerged }, en: { translation: enMerged } },
  lng: detectLang(),
  fallbackLng: "zh",
  interpolation: { escapeValue: false },
});

export function setLang(lang: Lang) {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // ignore
  }
  i18n.changeLanguage(lang);
}

export default i18n;
