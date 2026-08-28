// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  AiChatAuthorInfo,
  AuthenticatedApi,
  LanguagePreference,
  ServerConfig,
} from "@gadgets/workshop-shared/api";
import { useAuthenticatedApi, useOptionalAuthenticatedApi } from "./AuthContext";
import { ServerConfigContext } from "./ServerConfigContext";
import i18n from "./i18n/config";
import { LanguageProvider } from "./i18n/LanguageProvider";

const { addToast } = vi.hoisted(() => ({
  addToast: vi.fn<(toast: { title: string; variant: string }) => void>(),
}));

vi.mock("@cloudflare/kumo", () => ({
  useKumoToastManager: () => ({ add: addToast }),
}));
vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: vi.fn<typeof useAuthenticatedApi>(),
  useOptionalAuthenticatedApi: vi.fn<typeof useOptionalAuthenticatedApi>(),
}));
vi.mock("./useAvatar", () => ({
  useAvatar: () => null,
  invalidateAvatarCache: () => {},
}));
vi.mock("./useDocumentTitle", () => ({ useDocumentTitle: () => {} }));
vi.mock("./components/billing/UsageSettings", () => ({ default: () => null }));

import SettingsPage from "./SettingsPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const user: AiChatAuthorInfo = { type: "user", id: "user@example.com", name: "User" };
const serverConfig = { defaultLanguage: "en" } as ServerConfig;

describe("SettingsPage language selector", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let authenticatedApi: RpcStub<AuthenticatedApi>;
  let setLanguagePreference: ReturnType<typeof vi.fn<(preference: LanguagePreference) => Promise<void>>>;

  beforeEach(() => {
    setLanguagePreference = vi.fn<(preference: LanguagePreference) => Promise<void>>(async () => {});
    authenticatedApi = {
      whoami: async () => user,
      hasPasswordLogin: async () => true,
      getLanguagePreference: async () => "auto",
      setLanguagePreference,
    } as unknown as RpcStub<AuthenticatedApi>;
    const auth = { authenticatedApi } as ReturnType<typeof useAuthenticatedApi>;
    vi.mocked(useAuthenticatedApi).mockReturnValue(auth);
    vi.mocked(useOptionalAuthenticatedApi).mockReturnValue(auth);
  });

  afterEach(async () => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    addToast.mockReset();
    await i18n.changeLanguage("en");
    vi.clearAllMocks();
  });

  async function render() {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <ServerConfigContext.Provider value={serverConfig}>
          <LanguageProvider>
            <SettingsPage />
          </LanguageProvider>
        </ServerConfigContext.Provider>,
      );
      await Promise.resolve();
    });
    return container;
  }

  function selectLanguage(rendered: HTMLDivElement) {
    const select = rendered.querySelector<HTMLSelectElement>('select[aria-label="Language"]');
    expect(select).not.toBeNull();
    return select!;
  }

  async function change(select: HTMLSelectElement, preference: LanguagePreference) {
    await act(async () => {
      select.value = preference;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
  }

  it("shows Auto, English, and 日本語 with the persisted selection", async () => {
    const rendered = await render();
    const select = selectLanguage(rendered);
    const options = [...select.options].map((option) => option.textContent);

    expect(select.value).toBe("auto");
    expect(options).toEqual(["Auto (English)", "English", "日本語"]);
  });

  it("persists a choice and immediately translates the language controls", async () => {
    const rendered = await render();
    const select = selectLanguage(rendered);

    await change(select, "ja");

    expect(setLanguagePreference).toHaveBeenCalledWith("ja");
    expect(rendered.textContent).toContain("プロフィール");
    expect(rendered.textContent).toContain("アカウント");
    expect(rendered.textContent).toContain("言語");
    expect(rendered.textContent).toContain("セキュリティ");
    expect(rendered.textContent).toContain("現在のパスワード");
    expect(rendered.textContent).toContain("パスワードを変更");
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "自動（English）",
      "English",
      "日本語",
    ]);
    expect(select.value).toBe("ja");
  });

  it("keeps the selection and shows a translated failure toast", async () => {
    const rendered = await render();
    let select = selectLanguage(rendered);
    await change(select, "ja");

    setLanguagePreference.mockRejectedValueOnce(new Error("write failed"));
    select = rendered.querySelector("select")!;
    await change(select, "en");

    expect(select.value).toBe("ja");
    expect(addToast).toHaveBeenLastCalledWith({
      title: "言語設定を保存できませんでした。",
      variant: "error",
    });
  });
});
