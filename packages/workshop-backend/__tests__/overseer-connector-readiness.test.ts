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

const ACCOUNT_RESOURCE = {
  urlPattern: "https://github.com",
  title: "GitHub account",
  description: "Read repositories through the account.",
};
const BLOCKED_REPO_RESOURCE = {
  urlPattern: "https://github.com/:owner/:repo",
  title: "GitHub repository",
  description: "A grandfathered repository binding.",
  newConnectionsAllowed: false,
};
const CONFIGURED_VENDORS: GatekeeperVendorInfo[] = [{
  id: "github",
  description: {
    displayName: "GitHub",
    url: "https://github.com",
    configuration: { configured: true },
  },
  supportedResources: [ACCOUNT_RESOURCE, BLOCKED_REPO_RESOURCE],
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
  consumeCapturedConnectionRequests(chatId: number): unknown[];
  storage: {
    gatekeepers: { put(record: { id: number; class: object; creationSpec: object }): void };
  };
  getGatekeeperFacet(id: number): Promise<{ class: object }>;
};

function overseer(vendors: GatekeeperVendorInfo[] = VENDORS): ReadinessOverseer {
  const OverseerImpl = Reflect.get(overseerModule, "OverseerImpl");
  expect(OverseerImpl).toBeTypeOf("function");
  const target = Reflect.construct(OverseerImpl, [{
    id: { toString: () => "workspace-id" },
    storage: makeMockStorage(),
    exports: { UserDurableObject: {} },
    facets: {
      get: async (_name: string, factory: () => Promise<{ class: object }>) => await factory(),
    },
  }, {}]) as ReadinessOverseer;
  target.ownerId = "owner-id";
  target.users = {
    idFromString: () => "owner-id",
    get: () => ({ listGatekeeperVendors: async () => vendors }),
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

  it("omits vendors with no resource available for a new connection", async () => {
    const vendor = CONFIGURED_VENDORS[0]!;
    await expect(overseer([{
      ...vendor,
      supportedResources: [BLOCKED_REPO_RESOURCE],
    }]).listConnectableVendors()).resolves.toEqual([]);
  });

  it("advertises only resources that allow new connections", async () => {
    const output = await overseer(CONFIGURED_VENDORS).listConnectableResources("github");

    expect(output).toContain("GitHub account");
    expect(output).not.toContain("GitHub repository");
    expect(output).not.toContain(":owner/:repo");
  });

  it("rejects an agent request for a grandfathered scoped resource", async () => {
    const target = overseer(CONFIGURED_VENDORS);

    await expect(target.requestConnection(1, {
      vendorId: "github",
      resourceUrl: "https://github.com/cloudflare/workers-sdk",
      reason: "Inspect issues",
      bindingName: "GITHUB_REPO",
    })).resolves.toMatchObject({
      requested: false,
      message: expect.stringContaining("no longer available for new connections"),
    });
    expect(target.consumeCapturedConnectionRequests(1)).toEqual([]);
  });

  it("rehydrates an already-persisted scoped binding without applying new-connection policy", async () => {
    const target = overseer(CONFIGURED_VENDORS);
    const persistedClass = { persisted: true };
    target.storage.gatekeepers.put({
      id: 41,
      class: persistedClass,
      creationSpec: {
        type: "gatekeeper",
        vendorId: "github",
        resourceUrl: "https://github.com/cloudflare/workerd",
        typeUrlPattern: BLOCKED_REPO_RESOURCE.urlPattern,
      },
    });

    await expect(target.getGatekeeperFacet(41)).resolves.toEqual({ class: persistedClass });
  });

  it.each([undefined, "https://github.com"])(
    "accepts an agent request for the sole new account resource using URL %s",
    async resourceUrl => {
      const target = overseer(CONFIGURED_VENDORS);

      await expect(target.requestConnection(1, {
        vendorId: "github",
        resourceUrl,
        reason: "Inspect repositories",
        bindingName: "GITHUB",
      })).resolves.toMatchObject({ requested: true });
      expect(target.consumeCapturedConnectionRequests(1)).toEqual([
        expect.objectContaining({
          resourceTitle: "GitHub account",
          resourceUrlPattern: "https://github.com",
        }),
      ]);
    },
  );
});
