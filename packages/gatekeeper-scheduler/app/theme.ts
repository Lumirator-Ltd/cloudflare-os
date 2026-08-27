import {
  applyAccentColor,
  type GatekeeperAppTheme,
  type SupportedLanguage,
} from "@gadgets/workshop-shared/theme";

/** The concrete app color modes provided by Workshop. */
export type ResolvedThemeMode = "light" | "dark";

let currentLanguage: SupportedLanguage = document.documentElement.lang === "ja" ? "ja" : "en";
const languageListeners = new Set<(language: SupportedLanguage) => void>();

/** Applies the resolved color mode to the app document. */
export function applyThemeMode(mode: ResolvedThemeMode): void {
  document.documentElement.dataset.mode = mode;
  document.documentElement.style.colorScheme = mode;
}

/** Returns the current host-provided app language. */
export function getAppLanguage(): SupportedLanguage {
  return currentLanguage;
}

/** Subscribes to host language changes for React external-store consumers. */
export function subscribeAppLanguage(
  listener: (language: SupportedLanguage) => void,
): () => void {
  languageListeners.add(listener);
  return () => {
    languageListeners.delete(listener);
  };
}

/** Applies a host presentation update to the app document. */
export function applyAppTheme(theme: GatekeeperAppTheme): void {
  const language: SupportedLanguage = theme.language === "ja" ? "ja" : "en";
  applyThemeMode(theme.mode);
  applyAccentColor(document.documentElement.style, theme.accentColor);
  document.documentElement.lang = language;
  if (language === currentLanguage) return;
  currentLanguage = language;
  for (const listener of languageListeners) listener(language);
}
