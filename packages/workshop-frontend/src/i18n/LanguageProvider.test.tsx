// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  AuthenticatedApi,
  LanguagePreference,
  ServerConfig,
} from "@gadgets/workshop-shared/api";
import { ServerConfigContext } from "../ServerConfigContext";
import i18n from "./config";
import { LanguageProvider, useLanguage } from "./LanguageProvider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function languageApi(
  getLanguagePreference: () => Promise<LanguagePreference>,
  setLanguagePreference: (preference: LanguagePreference) => Promise<void> = async () => {},
): RpcStub<AuthenticatedApi> {
  return { getLanguagePreference, setLanguagePreference } as unknown as RpcStub<AuthenticatedApi>;
}

const config = (defaultLanguage: "en" | "ja") => ({ defaultLanguage }) as ServerConfig;

describe("LanguageProvider", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let current: ReturnType<typeof useLanguage> | undefined;

  function Probe() {
    current = useLanguage();
    return null;
  }

  async function render(
    authenticatedApi: RpcStub<AuthenticatedApi> | null,
    defaultLanguage: "en" | "ja" = "en",
  ) {
    if (!container) {
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    }
    await act(async () => {
      root!.render(
        <ServerConfigContext.Provider value={config(defaultLanguage)}>
          <LanguageProvider authenticatedApi={authenticatedApi}>
            <Probe />
          </LanguageProvider>
        </ServerConfigContext.Provider>,
      );
    });
  }

  afterEach(async () => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    current = undefined;
    document.documentElement.lang = "";
    await i18n.changeLanguage("en");
    vi.restoreAllMocks();
  });

  it("uses the deployment default for a signed-out Auto preference", async () => {
    await render(null, "ja");

    expect(current).toMatchObject({
      preference: "auto",
      effectiveLanguage: "ja",
      deploymentDefault: "ja",
      loading: false,
    });
    expect(document.documentElement.lang).toBe("ja");
    expect(i18n.resolvedLanguage).toBe("ja");
  });

  it("loads an authenticated user's saved preference", async () => {
    await render(languageApi(async () => "ja"));

    expect(current).toMatchObject({
      preference: "ja",
      effectiveLanguage: "ja",
      deploymentDefault: "en",
      loading: false,
    });
    expect(document.documentElement.lang).toBe("ja");
  });

  it("resets account-owned state when the API changes", async () => {
    await render(languageApi(async () => "ja"));
    expect(current?.preference).toBe("ja");

    const next = deferred<LanguagePreference>();
    await render(languageApi(() => next.promise));

    expect(current).toMatchObject({ preference: "auto", effectiveLanguage: "en", loading: true });
    expect(document.documentElement.lang).toBe("en");

    await act(async () => next.resolve("en"));
    expect(current).toMatchObject({ preference: "en", loading: false });
  });

  it("ignores a saved preference returned by a replaced API", async () => {
    const stale = deferred<LanguagePreference>();
    const active = deferred<LanguagePreference>();
    await render(languageApi(() => stale.promise));
    await render(languageApi(() => active.promise));

    await act(async () => stale.resolve("ja"));
    expect(current).toMatchObject({ preference: "auto", effectiveLanguage: "en", loading: true });

    await act(async () => active.resolve("en"));
    expect(current).toMatchObject({ preference: "en", effectiveLanguage: "en", loading: false });
  });

  it("falls back to Auto without blocking when loading fails", async () => {
    await render(languageApi(async () => { throw new Error("offline"); }), "ja");

    expect(current).toMatchObject({
      preference: "auto",
      effectiveLanguage: "ja",
      loading: false,
    });
  });

  it("resets to signed-out Auto on logout", async () => {
    await render(languageApi(async () => "ja"), "en");
    expect(current?.preference).toBe("ja");

    await render(null, "en");

    expect(current).toMatchObject({ preference: "auto", effectiveLanguage: "en", loading: false });
    expect(document.documentElement.lang).toBe("en");
  });

  it("persists before applying a choice and retains the previous choice on failure", async () => {
    const save = deferred<void>();
    const setter = vi.fn<(preference: LanguagePreference) => Promise<void>>(() => save.promise);
    await render(languageApi(async () => "auto", setter));

    let pending!: Promise<void>;
    await act(async () => {
      pending = current!.setPreference("ja");
      await Promise.resolve();
    });
    expect(setter).toHaveBeenCalledWith("ja");
    expect(current).toMatchObject({ preference: "auto", effectiveLanguage: "en", loading: true });

    await act(async () => {
      save.resolve();
      await pending;
    });
    expect(current).toMatchObject({ preference: "ja", effectiveLanguage: "ja", loading: false });

    setter.mockRejectedValueOnce(new Error("write failed"));
    await act(async () => {
      await expect(current!.setPreference("en")).rejects.toThrow("write failed");
    });
    expect(current).toMatchObject({ preference: "ja", effectiveLanguage: "ja", loading: false });
  });
});
