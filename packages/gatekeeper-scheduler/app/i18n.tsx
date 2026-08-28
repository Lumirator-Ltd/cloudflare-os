import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { SupportedLanguage } from "@gadgets/workshop-shared/theme";
import { getAppLanguage, subscribeAppLanguage } from "./theme";
import { catalogs } from "./translations";

const i18n = createInstance();

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: catalogs.en },
    ja: { translation: catalogs.ja },
  },
  lng: "en",
  fallbackLng: false,
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

/** Translates app copy outside React for the requested host language. */
export function translate(
  language: SupportedLanguage,
  key: string,
  values?: Record<string, unknown>,
): string {
  return i18n.getFixedT(language)(key, values ?? {}) as string;
}

/** Provides the app-local i18next instance synchronized to the host language. */
export function AppLanguageProvider({ children }: { children: ReactNode }) {
  const language = useAppLanguage();
  useEffect(() => {
    void i18n.changeLanguage(language);
    document.documentElement.lang = language;
    document.title = translate(language, "app.title");
  }, [language]);
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
