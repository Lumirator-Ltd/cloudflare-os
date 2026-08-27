import { expectTypeOf, it } from "vitest";
import type { SupportedLanguage } from "@gadgets/workshop-shared/api";
import type {
  ResourceConfiguratorHost,
  ResourceConfiguratorIframe,
} from "@gadgets/workshop-shared/gatekeeper";
import type { GatekeeperAppTheme } from "@gadgets/workshop-shared/theme";

it("documents supported language on embedded interface contracts", () => {
  expectTypeOf<GatekeeperAppTheme["language"]>().toEqualTypeOf<SupportedLanguage>();
  expectTypeOf<ResourceConfiguratorHost["getLanguage"]>()
    .toEqualTypeOf<(() => Promise<SupportedLanguage>) | undefined>();
  expectTypeOf<ResourceConfiguratorIframe["setLanguage"]>()
    .toEqualTypeOf<((language: SupportedLanguage) => void) | undefined>();
});
