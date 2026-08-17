// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => {
  const listModels = vi.fn<() => Promise<never[]>>(async () => []);
  const setTitle = vi.fn<(title: string) => Promise<void>>(async () => {});
  const newChat = vi.fn(async () => 0);
  const getMetadata = vi.fn(async () => ({ id: "workspace-1" }));
  const dispose = vi.fn();
  const overseer = { setTitle, newChat, getMetadata, [Symbol.dispose]: dispose };
  const newGadget = vi.fn(() => overseer);
  return {
    addToast: vi.fn<(toast: unknown) => void>(),
    authenticatedApi: { listModels, newGadget },
    dispose,
    getMetadata,
    listModels,
    navigate: vi.fn<(options: unknown) => void>(),
    newChat,
    newGadget,
    overseer,
    seeds: [] as Array<{ text?: string; nonce?: number }>,
    send: undefined as
      | ((message: string, modelId: string | null) => Promise<void>)
      | undefined,
    setTitle,
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => testState.navigate,
}));

vi.mock("@cloudflare/kumo", () => ({
  useKumoToastManager: () => ({ add: testState.addToast }),
}));

vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: testState.authenticatedApi,
  }),
}));

vi.mock("./ChatInterface", () => ({
  ChatInput: ({
    onSend,
    seedText,
    seedNonce,
  }: {
    onSend: (message: string, modelId: string | null) => Promise<void>;
    seedText?: string;
    seedNonce?: number;
  }) => {
    testState.send = onSend;
    testState.seeds.push({ text: seedText, nonce: seedNonce });
    return <textarea aria-label="Prompt" readOnly value={seedText ?? ""} />;
  },
}));

vi.mock("./components/MeshBackground", () => ({ default: () => null }));
vi.mock("./components/AppShell/HomeTaskSuggestions", () => ({ default: () => null }));
vi.mock("./useDocumentTitle", () => ({ useDocumentTitle: () => {} }));

import { HomePageContent } from "./routes/index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Home prompt route flow", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    localStorage.clear();
    testState.seeds.length = 0;
    testState.send = undefined;
    vi.clearAllMocks();
  });

  it("seeds the composer once, clears route state, and does not create a workspace", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<HomePageContent prompt="Create a daily brief." />));

    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')?.value).toBe(
      "Create a daily brief.",
    );
    expect(Math.max(...testState.seeds.map(({ nonce }) => nonce ?? 0))).toBe(1);
    expect(testState.navigate).toHaveBeenCalledWith({ to: "/", search: {}, replace: true });
    expect(testState.newGadget).not.toHaveBeenCalled();
  });

  it("names a new workspace from the first home-page message", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<HomePageContent />));

    await act(async () => testState.send!("Plan the Q3 launch", null));

    expect(testState.setTitle).toHaveBeenCalledWith("Plan the Q3 launch");
    expect(testState.navigate).toHaveBeenCalledWith({
      to: "/workspace/$id",
      params: { id: "workspace-1" },
      search: { chat: 0 },
    });
  });
});
