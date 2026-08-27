import { expectTypeOf, it } from "vitest";
import type {
  ConfiguratorUIRenderContext,
  ConfiguratorUIResourceContext,
} from "./index";

it("exposes the supported language in configurator render and resource contexts", () => {
  expectTypeOf<ConfiguratorUIRenderContext<unknown>["language"]>()
    .toEqualTypeOf<"en" | "ja">();
  expectTypeOf<ConfiguratorUIResourceContext<unknown>["language"]>()
    .toEqualTypeOf<"en" | "ja">();
});
