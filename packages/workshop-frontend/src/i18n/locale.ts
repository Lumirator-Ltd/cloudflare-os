import type { LanguagePreference, SupportedLanguage } from "@gadgets/workshop-shared/api";

export function resolveLanguage(
  preference: LanguagePreference,
  deploymentDefault: SupportedLanguage | undefined,
): SupportedLanguage {
  return preference === "auto" ? deploymentDefault ?? "en" : preference;
}
