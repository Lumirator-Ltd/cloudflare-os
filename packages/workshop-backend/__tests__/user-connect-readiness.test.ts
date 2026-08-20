import { describe, expect, it } from "vitest";
import type { GatekeeperVendor } from "@gadgets/workshop-shared/gatekeeper";
import { UserDurableObject } from "../src/user.js";

const UNCONFIGURED_MESSAGE =
  "This connector is not configured. Ask an administrator to configure it.";

function connectedUser(newConnectionsAllowed: boolean | undefined = undefined) {
  let ensureCalls = 0;
  let reconnectCalls = 0;
  let capabilityCalls = 0;
  const account = {
    async ensureResources() {
      ensureCalls++;
      return { url: "https://example.com/additional-scope" };
    },
    async reconnect() {
      reconnectCalls++;
      return { url: "https://example.com/reconnect" };
    },
    async getGatekeeperClassFor() {
      capabilityCalls++;
      return {
        class: {},
        resource: {
          urlPattern: "https://github.com/:owner/:repo",
          title: "GitHub repository",
          description: "A repository",
          newConnectionsAllowed,
        },
      };
    },
  };
  const record = { id: 7, account, vendorId: "github", description: { avatar: { url: "" } } };
  const vendor = {
    async describe() {
      return {
        displayName: "GitHub",
        url: "https://github.com",
        configuration: { configured: false },
      };
    },
  } as Service<GatekeeperVendor>;
  const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
  Object.assign(user, {
    vendors: new Map([["github", vendor]]),
    env: { BLUEPRINTS: { get: async () => null } },
    storage: { connectedAccounts: { get: (id: number) => id === 7 ? record : undefined } },
  });
  return {
    user,
    calls: () => ({ ensureCalls, reconnectCalls, capabilityCalls }),
  };
}

describe("UserDurableObject connector readiness", () => {
  it("rejects an unconfigured connector before allocating account state or connecting", async () => {
    let nextAccountId = 12;
    let callbackAllocations = 0;
    let connectCalls = 0;
    const vendor = {
      async describe() {
        return {
          displayName: "GitHub",
          url: "https://github.com",
          configuration: { configured: false },
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

  it("rejects additional-scope authorization for an unconfigured connector", async () => {
    const { user, calls } = connectedUser();

    await expect(user.ensureAccountResources(7, ["https://github.com/:owner/:repo"]))
      .rejects.toThrow(UNCONFIGURED_MESSAGE);
    expect(calls().ensureCalls).toBe(0);
  });

  it("rejects reconnect authorization for an unconfigured connector", async () => {
    const { user, calls } = connectedUser();

    await expect(user.reconnectAccount(7)).rejects.toThrow(UNCONFIGURED_MESSAGE);
    expect(calls().reconnectCalls).toBe(0);
  });

  it("allows new capabilities when the resource uses the default policy", async () => {
    const { user, calls } = connectedUser();

    await expect(user.getGatekeeperClassFor(7, "https://github.com"))
      .resolves.toMatchObject({
        vendorId: "github",
        typeUrlPattern: "https://github.com/:owner/:repo",
      });
    expect(calls().capabilityCalls).toBe(1);
  });

  it("rejects a direct bypass that tries to mint a blocked scoped capability", async () => {
    const { user, calls } = connectedUser(false);

    await expect(user.getGatekeeperClassFor(7, "https://github.com/cloudflare/workers-sdk"))
      .rejects.toThrow("no longer available for new connections");
    expect(calls().capabilityCalls).toBe(1);
  });
});
