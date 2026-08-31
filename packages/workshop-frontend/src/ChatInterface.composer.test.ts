// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Toasty, TooltipProvider } from "@cloudflare/kumo";
import type { SlashCommandRequest } from "@gadgets/workshop-shared/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatInput } from "./ChatInterface";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: null }),
}));
vi.mock("./useVendorBranding", () => ({
  useVendorBranding: () => new Map(),
}));

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverMock;

async function enterText(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  await act(async () => {
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pressEnter(textarea: HTMLTextAreaElement, init: KeyboardEventInit = {}) {
  const enter = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Enter",
    ...init,
  });
  await act(async () => {
    textarea.dispatchEvent(enter);
    await Promise.resolve();
  });
  return enter;
}

describe("ChatInput keyboard handling", () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
    vi.restoreAllMocks();
  });

  async function render() {
    const onSend = vi.fn<(message: string | SlashCommandRequest) => void>();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root.render(createElement(
        TooltipProvider,
        null,
        createElement(
          Toasty,
          null,
          createElement(ChatInput, {
            createCapsuleGatekeeper: async () => null,
            getOverseer: async () => null as never,
            onSend,
            isAgentActive: false,
            models: [],
            selectedModel: null,
            onModelChange: vi.fn<(modelId: string | null) => void>(),
          }),
        ),
      ));
    });

    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("Chat input textarea not found");
    return { onSend, textarea };
  }

  it("lets Enter confirm an active IME composition without sending", async () => {
    const { onSend, textarea } = await render();
    await enterText(textarea, "日本語");

    const enter = await pressEnter(textarea, { isComposing: true });

    expect(enter.defaultPrevented).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("lets Safari's IME confirmation Enter finish without sending", async () => {
    const { onSend, textarea } = await render();
    await enterText(textarea, "日本語");

    const enter = await pressEnter(textarea, { keyCode: 229 });

    expect(enter.defaultPrevented).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("sends after IME composition has finished", async () => {
    const { onSend, textarea } = await render();
    await enterText(textarea, "日本語");

    const enter = await pressEnter(textarea);

    expect(enter.defaultPrevented).toBe(true);
    expect(onSend).toHaveBeenCalledOnce();
    expect(onSend.mock.calls[0][0]).toBe("日本語");
  });

  it("keeps Shift+Enter available for a newline", async () => {
    const { onSend, textarea } = await render();
    await enterText(textarea, "日本語");

    const enter = await pressEnter(textarea, { shiftKey: true });

    expect(enter.defaultPrevented).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
  });
});
