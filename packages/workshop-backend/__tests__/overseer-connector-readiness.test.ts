import { describe, expect, it, vi } from "vitest";
import type { GatekeeperVendorInfo } from "@gadgets/workshop-shared/api";
import * as overseerModule from "../src/overseer.js";
import { makeMockStorage } from "./mock-storage.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

const UNCONFIGURED_MESSAGE =
  "This connector is not configured. Ask an administrator to configure it.";

const VENDORS: GatekeeperVendorInfo[] = [{
  id: "github",
  description: {
    displayName: "GitHub",
    url: "https://github.com",
    configuration: { configured: false },
  },
  supportedResources: [{
    urlPattern: "https://github.com/:owner/:repo",
    title: "GitHub repository",
    description: "A repository",
  }],
}];

type ReadinessOverseer = {
  ownerId?: string;
  users: unknown;
  listConnectableVendors(): Promise<Array<{ id: string; displayName: string }>>;
  listConnectableResources(vendorId: string): Promise<string>;
  requestConnection(chatId: number, input: {
    vendorId: string;
    resourceUrl?: string;
    reason: string;
    bindingName: string;
  }): Promise<{ requested: boolean; message: string }>;
};

function overseer(): ReadinessOverseer {
  const OverseerImpl = Reflect.get(overseerModule, "OverseerImpl");
  expect(OverseerImpl).toBeTypeOf("function");
  const target = Reflect.construct(OverseerImpl, [{
    id: { toString: () => "workspace-id" },
    storage: makeMockStorage(),
    exports: { UserDurableObject: {} },
  }, {}]) as ReadinessOverseer;
  target.ownerId = "owner-id";
  target.users = {
    idFromString: () => "owner-id",
    get: () => ({ listGatekeeperVendors: async () => VENDORS }),
  };
  return target;
}

describe("Overseer agent connector readiness", () => {
  it("does not advertise unconfigured vendors as connectable", async () => {
    await expect(overseer().listConnectableVendors()).resolves.toEqual([]);
  });

  it("rejects crafted resource discovery for an unconfigured vendor", async () => {
    await expect(overseer().listConnectableResources("github"))
      .rejects.toThrow(UNCONFIGURED_MESSAGE);
  });

  it("rejects crafted connection requests without recording a request", async () => {
    const target = overseer();

    await expect(target.requestConnection(1, {
      vendorId: "github",
      resourceUrl: "https://github.com/cloudflare/workers-sdk",
      reason: "Inspect issues",
      bindingName: "GITHUB_REPO",
    })).resolves.toEqual({ requested: false, message: UNCONFIGURED_MESSAGE });
  });
});
