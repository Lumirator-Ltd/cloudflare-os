import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./locales/en";
import { ja } from "./locales/ja";

const i18n = createInstance();

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ja: { translation: ja },
  },
  lng: "en",
  fallbackLng: "en",
  supportedLngs: ["en", "ja"],
  initAsync: false,
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
