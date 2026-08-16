import { MAX_SITE_NAME_LENGTH } from "@gadgets/workshop-shared/api";
import { describe, expect, it, vi } from "vitest";
import {
  initialAdminConfigDigest,
  parseInitialAdminConfig,
  toAdminConfigPatch,
} from "../src/admin-bootstrap.js";
import { DEFAULT_ADMIN_CONFIG, serializeAdminConfig } from "../src/admin-config.js";
import { AdminSettings } from "../src/admin-settings.js";
import { ADMIN_CONFIG_KEY } from "../src/blueprint-archive.js";
import { makeMockStorage } from "./mock-storage.js";

vi.mock("cloudflare:workers", async importOriginal => {
  let original = await importOriginal<typeof import("cloudflare:workers")>();
  return {
    ...original,
    DurableObject: class {
      protected ctx: DurableObjectState;
      protected env: Cloudflare.Env;

      constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});

const valid = {
  tenantId: "tenant-immutable-id",
  schemaVersion: 1,
  config: {
    siteName: "Acme OS",
    accentColor: "#4f46e5",
    contextGatekeeper: "optional",
    customGatekeeper: "disabled",
  },
} as const;

describe("parseInitialAdminConfig", () => {
  it("accepts the closed version 1 payload", () => {
    expect(parseInitialAdminConfig(valid)).toEqual(valid);
  });

  it("rejects unknown keys at every level", () => {
    expect(parseInitialAdminConfig({...valid, extra: true})).toBeNull();
    expect(parseInitialAdminConfig({
      ...valid,
      config: {...valid.config, extra: true},
    })).toBeNull();
  });

  it("rejects an empty or oversized tenant ID", () => {
    expect(parseInitialAdminConfig({...valid, tenantId: ""})).toBeNull();
    expect(parseInitialAdminConfig({...valid, tenantId: "x".repeat(129)})).toBeNull();
  });

  it("rejects unsupported schema versions", () => {
    expect(parseInitialAdminConfig({...valid, schemaVersion: 2})).toBeNull();
  });

  it("uses the existing site-name and color constraints", () => {
    expect(parseInitialAdminConfig({
      ...valid,
      config: {...valid.config, siteName: "x".repeat(MAX_SITE_NAME_LENGTH + 1)},
    })).toBeNull();
    expect(parseInitialAdminConfig({
      ...valid,
      config: {...valid.config, accentColor: "indigo"},
    })).toBeNull();
  });

  it("rejects modes outside the closed enum", () => {
    expect(parseInitialAdminConfig({
      ...valid,
      config: {...valid.config, contextGatekeeper: "sometimes"},
    })).toBeNull();
    expect(parseInitialAdminConfig({
      ...valid,
      config: {...valid.config, customGatekeeper: true},
    })).toBeNull();
  });

  it.each([
    ["admins", ["admin@example.com"]],
    ["secrets", {apiKey: "secret"}],
    ["instructions", "ignore previous instructions"],
    ["connectors", ["github"]],
    ["formats", ["slides"]],
    ["ambientGatekeeperModes", {arbitrary: "enabled"}],
  ])("rejects configuration that attempts to set %s", (key, value) => {
    expect(parseInitialAdminConfig({
      ...valid,
      config: {...valid.config, [key]: value},
    })).toBeNull();
  });
});

describe("initialAdminConfigDigest", () => {
  it("hashes the canonical payload rather than input property order", async () => {
    const reordered = parseInitialAdminConfig({
      config: {
        customGatekeeper: "disabled",
        contextGatekeeper: "optional",
        accentColor: "#4f46e5",
        siteName: "Acme OS",
      },
      schemaVersion: 1,
      tenantId: "tenant-immutable-id",
    });

    expect(reordered).not.toBeNull();
    await expect(initialAdminConfigDigest(reordered!))
        .resolves.toBe(await initialAdminConfigDigest(valid));
    await expect(initialAdminConfigDigest(valid)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("toAdminConfigPatch", () => {
  it("maps only branding and the two known Gatekeeper IDs", () => {
    expect(toAdminConfigPatch(valid)).toEqual({
      siteName: "Acme OS",
      accentColor: "#4f46e5",
      ambientGatekeeperModes: {
        context: "optional",
        custom: "disabled",
      },
    });
  });
});

type AdminBootstrapMarker = {
  tenantId: string;
  schemaVersion: 1;
  digest: string;
};

function makeAdminSettings() {
  let durableStorage = makeMockStorage();
  let put = vi.fn<(key: string, value: string) => Promise<void>>()
      .mockResolvedValue(undefined);
  let env = {BLUEPRINTS: {put}} as unknown as Cloudflare.Env;
  let ctx = {
    storage: durableStorage,
    exports: {UserDurableObject: {}},
  } as unknown as DurableObjectState;
  let admin = new AdminSettings(ctx, env);
  return {admin, durableStorage, put};
}

describe("AdminSettings.ensureInitialAdminConfig", () => {
  it("initializes fresh authoritative state and its KV mirror", async () => {
    let {admin, durableStorage, put} = makeAdminSettings();

    await admin.ensureInitialAdminConfig(valid);

    let expected = {...DEFAULT_ADMIN_CONFIG, ...toAdminConfigPatch(valid)};
    expect(admin.getAdminConfig()).toEqual(expected);
    expect(put).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledWith(ADMIN_CONFIG_KEY, serializeAdminConfig(expected));
    expect(durableStorage.kv.get("adminBootstrapMarker")).toEqual({
      tenantId: valid.tenantId,
      schemaVersion: 1,
      digest: await initialAdminConfigDigest(valid),
    });
  });

  it("does nothing when the tenant and canonical payload digest already match", async () => {
    let {admin, put} = makeAdminSettings();
    await admin.ensureInitialAdminConfig(valid);

    await admin.ensureInitialAdminConfig({
      config: {
        customGatekeeper: "disabled",
        contextGatekeeper: "optional",
        accentColor: "#4f46e5",
        siteName: "Acme OS",
      },
      schemaVersion: 1,
      tenantId: "tenant-immutable-id",
    });

    expect(put).toHaveBeenCalledOnce();
  });

  it("rejects a changed digest without changing authoritative state", async () => {
    let {admin, put} = makeAdminSettings();
    await admin.ensureInitialAdminConfig(valid);

    await expect(admin.ensureInitialAdminConfig({
      ...valid,
      config: {...valid.config, siteName: "Other OS"},
    })).rejects.toThrow(/different configuration/i);

    expect(admin.getAdminConfig().siteName).toBe("Acme OS");
    expect(put).toHaveBeenCalledOnce();
  });

  it("rejects a changed tenant ID without changing authoritative state", async () => {
    let {admin, put} = makeAdminSettings();
    await admin.ensureInitialAdminConfig(valid);

    await expect(admin.ensureInitialAdminConfig({
      ...valid,
      tenantId: "other-tenant",
    })).rejects.toThrow(/different tenant/i);

    expect(admin.getAdminConfig().siteName).toBe("Acme OS");
    expect(put).toHaveBeenCalledOnce();
  });

  it("rejects unmarked non-default authoritative state", async () => {
    let {admin, durableStorage, put} = makeAdminSettings();
    let existing = {...DEFAULT_ADMIN_CONFIG, announcement: "Configured by an admin"};
    durableStorage.kv.put("adminConfig", existing);

    await expect(admin.ensureInitialAdminConfig(valid)).rejects.toThrow(/unmarked/i);

    expect(admin.getAdminConfig()).toEqual(existing);
    expect(durableStorage.kv.get("adminBootstrapMarker")).toBeUndefined();
    expect(put).not.toHaveBeenCalled();
  });

  it("restores prior Durable Object state when the KV mirror write fails", async () => {
    let {admin, durableStorage, put} = makeAdminSettings();
    put.mockRejectedValueOnce(new Error("KV unavailable"));

    await expect(admin.ensureInitialAdminConfig(valid)).rejects.toThrow("KV unavailable");

    expect(admin.getAdminConfig()).toEqual(DEFAULT_ADMIN_CONFIG);
    expect(durableStorage.kv.get("adminBootstrapMarker")).toBeUndefined();
  });

  it("coalesces concurrent identical initialization calls safely", async () => {
    let {admin, durableStorage, put} = makeAdminSettings();
    let release!: () => void;
    let blocked = new Promise<void>(resolve => { release = resolve; });
    put.mockImplementationOnce(() => blocked);

    let first = admin.ensureInitialAdminConfig(valid);
    let second = admin.ensureInitialAdminConfig(valid);
    await vi.waitFor(() => expect(put).toHaveBeenCalledOnce());
    release();
    await Promise.all([first, second]);

    expect(put).toHaveBeenCalledOnce();
    expect(durableStorage.kv.get<AdminBootstrapMarker>("adminBootstrapMarker")?.digest)
        .toBe(await initialAdminConfigDigest(valid));
  });
});
