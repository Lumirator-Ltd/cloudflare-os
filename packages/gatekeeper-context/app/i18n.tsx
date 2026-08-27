import React, { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { SupportedLanguage } from "@gadgets/workshop-shared/theme";
import { getAppLanguage, subscribeAppLanguage } from "./theme";

const i18n = createInstance();

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: { test: { language: "English" } } },
    ja: { translation: { test: { language: "日本語" } } },
  },
  lng: "en",
  fallbackLng: "en",
  supportedLngs: ["en", "ja"],
  initAsync: false,
  interpolation: { escapeValue: false },
});

/** Returns the reactive language supplied by the Workshop host. */
export function useAppLanguage(): SupportedLanguage {
  return useSyncExternalStore(
    (listener) => subscribeAppLanguage(listener),
    getAppLanguage,
    getAppLanguage,
  );
}

/** Provides the app-local i18next instance synchronized to the host language. */
export function AppLanguageProvider({ children }: { children: ReactNode }) {
  const language = useAppLanguage();
  useEffect(() => {
    void i18n.changeLanguage(language);
  }, [language]);
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
