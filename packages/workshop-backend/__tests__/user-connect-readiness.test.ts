import { describe, expect, it } from "vitest";
import type { GatekeeperVendor } from "@gadgets/workshop-shared/gatekeeper";
import { UserDurableObject } from "../src/user.js";

const UNCONFIGURED_MESSAGE =
  "This connector is not configured. Ask an administrator to configure it.";

describe("UserDurableObject.connectAccount connector readiness", () => {
  it("rejects an unconfigured connector before allocating account state or connecting", async () => {
    let nextAccountId = 12;
    let callbackAllocations = 0;
    let connectCalls = 0;
    const vendor = {
      async describe() {
        return {
          displayName: "GitHub",
          url: "https://github.com",
          configuration: { configured: false, inputs: [] },
        };
      },
      async connectAccount() {
        connectCalls++;
        return { url: "https://example.com/oauth" };
      },
    } as Service<GatekeeperVendor>;
    const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
    Object.assign(user, {
      vendors: new Map([["github", vendor]]),
      env: { BLUEPRINTS: { get: async () => null } },
      storage: {
        nextAccountId: {
          get: () => nextAccountId,
          put: (value: number) => { nextAccountId = value; },
        },
      },
      ctx: {
        id: { toString: () => "user-id" },
        exports: {
          GatekeeperConnectCallbackImpl() {
            callbackAllocations++;
            return {};
          },
        },
      },
    });

    await expect(user.connectAccount("github")).rejects.toThrow(UNCONFIGURED_MESSAGE);
    expect(nextAccountId).toBe(12);
    expect(callbackAllocations).toBe(0);
    expect(connectCalls).toBe(0);
  });
});
