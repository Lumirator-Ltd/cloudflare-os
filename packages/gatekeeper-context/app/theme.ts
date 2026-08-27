// This opaque-origin app receives Workshop presentation state over RPC. Mode subscriptions keep
// imperative widgets such as CodeMirror and the emoji picker synchronized at runtime.

import {
  applyAccentColor,
  type GatekeeperAppTheme,
  type SupportedLanguage,
} from "@gadgets/workshop-shared/theme";

/** The two concrete modes the host resolves `light`/`dark`/`system` down to before pushing it here. */
export type ResolvedThemeMode = "light" | "dark";

// Seed from the pre-paint `data-mode` the bootstrap script in index.html set from the OS preference,
// so imperative widgets that read getThemeMode() before the host's RPC arrives start correct.
let currentMode: ResolvedThemeMode =
  document.documentElement.getAttribute("data-mode") === "dark" ? "dark" : "light";
let currentLanguage: SupportedLanguage = document.documentElement.lang === "ja" ? "ja" : "en";
const modeListeners = new Set<(mode: ResolvedThemeMode) => void>();
const languageListeners = new Set<(language: SupportedLanguage) => void>();

/** Returns the current resolved color mode. */
export function getThemeMode(): ResolvedThemeMode {
  return currentMode;
}

/** Returns the current host-provided app language. */
export function getAppLanguage(): SupportedLanguage {
  return currentLanguage;
}

/** Apply a resolved mode to <html> and notify subscribers. Idempotent per value. */
export function applyThemeMode(mode: ResolvedThemeMode): void {
  const root = document.documentElement;
  root.setAttribute("data-mode", mode);
  root.style.colorScheme = mode;
  if (mode === currentMode) return;
  currentMode = mode;
  for (const listener of modeListeners) listener(mode);
}

/** Applies a host presentation update to the app document. */
export function applyAppTheme(theme: GatekeeperAppTheme): void {
  applyThemeMode(theme.mode);
  applyAccentColor(document.documentElement.style, theme.accentColor);
  document.documentElement.lang = theme.language;
  if (theme.language === currentLanguage) return;
  currentLanguage = theme.language;
  for (const listener of languageListeners) listener(theme.language);
}

/** Subscribe to mode changes. Returns an unsubscribe function. */
export function subscribeThemeMode(
  listener: (mode: ResolvedThemeMode) => void,
): () => void {
  modeListeners.add(listener);
  return () => {
    modeListeners.delete(listener);
  };
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
