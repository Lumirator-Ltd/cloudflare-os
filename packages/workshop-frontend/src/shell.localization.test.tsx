// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GadgetMetadataWithTimestamps, ServerConfig } from "@gadgets/workshop-shared/api";
import { ServerConfigContext, ServerConfigErrorContext } from "./ServerConfigContext";
import i18n from "./i18n/config";
import { LanguageProvider } from "./i18n/LanguageProvider";
import LoginPage from "./LoginPage";
import SignupPage from "./SignupPage";
import AnnouncementBanner from "./components/AnnouncementBanner";
import HomeTaskSuggestions from "./components/AppShell/HomeTaskSuggestions";
import RecentApps from "./components/RecentApps";
import ReconnectingChip from "./components/ReconnectingChip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const authMocks = vi.hoisted(() => ({
  listGadgets: vi.fn<() => Promise<GadgetMetadataWithTimestamps[]>>(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));

vi.mock("@cloudflare/kumo", () => ({
  Banner: ({ title, children }: { title: string; children?: ReactNode }) => <div>{title}{children}</div>,
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  Input: ({ label, placeholder }: { label: string; placeholder?: string }) => (
    <label>{label}<input placeholder={placeholder} /></label>
  ),
  Loader: () => <div />,
}));

vi.mock("./components/auth/OAuthButtons", () => ({ default: () => null }));
vi.mock("./components/SiteLogo", () => ({
  default: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: authMocks }),
  useOptionalAuthenticatedApi: () => null,
}));

const serverConfig = {
  defaultLanguage: "ja",
  siteName: "Workshop",
  passwordAuthEnabled: true,
  signupsEnabled: true,
  authVendors: [],
} as unknown as ServerConfig;

function Providers({ children, config = serverConfig }: { children: ReactNode; config?: ServerConfig }) {
  return (
    <I18nextProvider i18n={i18n}>
      <ServerConfigErrorContext.Provider value={false}>
        <ServerConfigContext.Provider value={config}>
          <LanguageProvider authenticatedApi={null}>{children}</LanguageProvider>
        </ServerConfigContext.Provider>
      </ServerConfigErrorContext.Provider>
    </I18nextProvider>
  );
}

describe("Japanese Workshop shell", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await i18n.changeLanguage("ja");
    localStorage.clear();
  });

  afterEach(async () => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.clearAllMocks();
    await i18n.changeLanguage("en");
  });

  async function render(node: ReactNode, config?: ServerConfig) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<Providers config={config}>{node}</Providers>));
    return container;
  }

  it("renders login and signup copy in Japanese while preserving the deployment name", async () => {
    let rendered = await render(<LoginPage rpcStub={{} as never} />);

    expect(rendered.textContent).toContain("Workshop");
    expect(rendered.textContent).toContain("アカウントにサインイン");
    expect(rendered.textContent).toContain("ユーザー名");
    expect(rendered.textContent).toContain("パスワード");
    expect(rendered.textContent).toContain("アカウントを作成");
    expect(document.title).toBe("サインイン - Workshop");

    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;

    rendered = await render(<SignupPage rpcStub={{} as never} />);
    expect(rendered.textContent).toContain("アカウントを作成");
    expect(rendered.textContent).toContain("パスワード（確認）");
    expect(rendered.textContent).toContain("すでにアカウントをお持ちですか？");
    expect(document.title).toBe("アカウントを作成 - Workshop");
  });

  it("localizes shell status and dismiss controls without translating announcement content", async () => {
    const config = { ...serverConfig, banner: "Maintenance at 5 PM" } as ServerConfig;
    const rendered = await render(
      <><AnnouncementBanner /><ReconnectingChip /></>,
      config,
    );

    expect(rendered.textContent).toContain("Maintenance at 5 PM");
    expect(rendered.textContent).toContain("再接続中…");
    const dismiss = rendered.querySelector<HTMLButtonElement>('button[aria-label="バナーを閉じる"]');
    expect(dismiss?.title).toBe("閉じる");
  });

  it("inserts a Japanese starter prompt", async () => {
    const onPick = vi.fn<(prompt: string) => void>();
    const rendered = await render(<HomeTaskSuggestions onPick={onPick} />);

    expect(rendered.querySelector("section")?.getAttribute("aria-label")).toBe("タスク例");
    expect(rendered.textContent).toContain("始めてみましょう");
    act(() => rendered.querySelector("button")?.click());
    expect(onPick).toHaveBeenCalledOnce();
    expect(onPick.mock.calls[0][0]).toMatch(/[ぁ-んァ-ヶ一-龠]/u);
  });

  it("uses Japanese relative-time and ownership grammar for recent workspaces", async () => {
    authMocks.listGadgets.mockResolvedValue([{
      id: "workspace-1",
      title: "Quarterly plan",
      owner: { name: "田中" },
      lastActive: new Date(Date.now() - 3 * 60_000),
    } as GadgetMetadataWithTimestamps]);

    const rendered = await render(<RecentApps />);

    expect(rendered.textContent).toContain("最近のワークスペース");
    expect(rendered.textContent).toContain("田中さんが共有");
    expect(rendered.textContent).toMatch(/3\s*分前/u);
  });
});
