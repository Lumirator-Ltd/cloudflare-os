import { describe, expect, it } from "vitest";
import type { GatekeeperVendor } from "@gadgets/workshop-shared/gatekeeper";
import * as serverModule from "../src/server.js";
import { getAuthVendors, getServerConfig } from "../src/deployment-config.js";

const UNCONFIGURED_MESSAGE =
  "This connector is not configured. Ask an administrator to configure it.";

function authVendor(configured: boolean, connect: () => void = () => {}): Service<GatekeeperVendor> {
  return {
    async describe() {
      return {
        displayName: "GitHub",
        url: "https://github.com",
        providesAuth: true,
        configuration: { configured },
      };
    },
    async connectAccount() {
      connect();
      return { url: "https://github.com/login/oauth" };
    },
  } as Service<GatekeeperVendor>;
}

function environment(vendor: Service<GatekeeperVendor>): Cloudflare.Env {
  return {
    AUTH_GATEKEEPERS: "github",
    GATEKEEPER_GITHUB: vendor,
    BLUEPRINTS: { get: async () => null },
  } as unknown as Cloudflare.Env;
}

describe("authentication connector readiness", () => {
  it("propagates readiness into AuthVendorInfo and restores password fallback", async () => {
    const env = environment(authVendor(false));
    env.DISABLE_PASSWORD_AUTH = "true";

    await expect(getAuthVendors(env)).resolves.toEqual([{
      vendorId: "github",
      displayName: "GitHub",
      logo: undefined,
      color: undefined,
      configured: false,
    }]);
    await expect(getServerConfig(env)).resolves.toMatchObject({
      authVendors: [{ vendorId: "github", configured: false }],
      passwordAuthEnabled: true,
    });
  });

  it("allows password login fallback when every allowlisted auth connector is unconfigured", async () => {
    const env = environment(authVendor(false));
    env.DISABLE_PASSWORD_AUTH = "true";
    const PublicApiImpl = Reflect.get(serverModule, "PublicApiImpl");
    expect(PublicApiImpl).toBeTypeOf("function");
    const user = { login: async () => "session" };
    const target = Reflect.construct(PublicApiImpl, [{
      exports: {
        UserDurableObject: {
          idFromName: (name: string) => name,
          get: () => user,
        },
      },
    }, env, () => {}]);

    await expect(Reflect.apply(target.login, target, ["person", new Uint8Array([1])]))
      .resolves.toBe("person:session");
  });

  it("rejects PublicApi sign-in before allocating login state or calling the vendor", async () => {
    let connectCalls = 0;
    let allocationCalls = 0;
    const PublicApiImpl = Reflect.get(serverModule, "PublicApiImpl");
    expect(PublicApiImpl).toBeTypeOf("function");
    const target = Reflect.construct(PublicApiImpl, [{
      exports: {
        UserDurableObject: {},
        PendingLogin: {
          newUniqueId() {
            allocationCalls++;
            return { toString: () => "pending" };
          },
        },
      },
    }, environment(authVendor(false, () => { connectCalls++; })), () => {}]);

    await expect(Reflect.apply(target.startGatekeeperLogin, target, ["github"]))
      .rejects.toThrow(UNCONFIGURED_MESSAGE);
    expect(allocationCalls).toBe(0);
    expect(connectCalls).toBe(0);
  });
});
