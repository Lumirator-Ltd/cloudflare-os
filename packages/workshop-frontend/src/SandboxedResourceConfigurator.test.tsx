// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { newMessagePortRpcSession, RpcStub, RpcTarget } from "capnweb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ResourceConfiguratorFrame,
  ResourceConfiguratorIframe,
} from "@gadgets/workshop-shared/gatekeeper";
import type { SupportedLanguage } from "@gadgets/workshop-shared/api";
import SandboxedResourceConfigurator from "./SandboxedResourceConfigurator";

let effectiveLanguage: SupportedLanguage = "en";

vi.mock("./i18n/LanguageProvider", () => ({
  useLanguage: () => ({ effectiveLanguage }),
}));

vi.mock("./ThemeContext", () => ({
  useTheme: () => ({ resolvedThemeMode: "light" }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("./errorReporting", () => ({
  forwardTrustedFrameError: () => false,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface TestHost extends RpcTarget {
  getLanguage(): Promise<SupportedLanguage>;
}

class EmptyUi extends RpcTarget {}

class TestConfiguratorIframe extends RpcTarget implements ResourceConfiguratorIframe {
  readonly languages: SupportedLanguage[] = [];

  collectResourceUrl(): Promise<string> {
    return Promise.resolve("https://example.com/resource");
  }

  updateViewport(): void {}

  windowResized(): void {}

  setLanguage(language: SupportedLanguage): void {
    this.languages.push(language);
  }
}

describe("SandboxedResourceConfigurator language propagation", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;
  let host: RpcStub<TestHost> | undefined;

  beforeEach(() => {
    effectiveLanguage = "en";
    let frame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++frame;
      queueMicrotask(() => callback(performance.now()));
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 320,
      bottom: 80,
      left: 0,
      width: 320,
      height: 80,
      toJSON: () => ({}),
    });
  });

  afterEach(async () => {
    host?.[Symbol.dispose]();
    await act(async () => root?.unmount());
    container?.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("provides the initial language and pushes live changes to the iframe", async () => {
    const frame = {
      iframeHtml: "<!doctype html><title>Configurator</title>",
      ui: new RpcStub(new EmptyUi()),
    } as unknown as ResourceConfiguratorFrame;

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<SandboxedResourceConfigurator frame={frame} />));

    const iframe = await vi.waitFor(() => {
      const found = document.body.querySelector("iframe");
      expect(found).not.toBeNull();
      return found as HTMLIFrameElement;
    });
    const iframeTarget = new TestConfiguratorIframe();
    const { port1, port2 } = new MessageChannel();
    host = newMessagePortRpcSession<TestHost>(port1, iframeTarget);
    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "handshake" },
      origin: "null",
      source: iframe.contentWindow,
      ports: [port2],
    }));

    await expect(host.getLanguage()).resolves.toBe("en");

    effectiveLanguage = "ja";
    await act(async () => root!.render(<SandboxedResourceConfigurator frame={frame} />));
    await vi.waitFor(() => expect(iframeTarget.languages).toContain("ja"));
  });
});
