import { expectTypeOf, it } from "vitest";
import { localize, type ConfiguratorUILocalizedText } from "./index";
import type {
  ConfiguratorUILanguage,
  ConfiguratorUIRenderContext,
  ConfiguratorUIResourceContext,
} from "./index";

it("exposes the supported language in configurator render and resource contexts", () => {
  expectTypeOf<ConfiguratorUIRenderContext<unknown>["language"]>()
    .toEqualTypeOf<"en" | "ja">();
  expectTypeOf<ConfiguratorUIResourceContext<unknown>["language"]>()
    .toEqualTypeOf<"en" | "ja">();
});

it("requires whole English and Japanese choices", () => {
  expectTypeOf<ConfiguratorUILocalizedText>().toEqualTypeOf<{ en: string; ja: string }>();
  expectTypeOf(localize).toEqualTypeOf<(
    language: ConfiguratorUILanguage,
    choices: ConfiguratorUILocalizedText,
  ) => string>();
});
