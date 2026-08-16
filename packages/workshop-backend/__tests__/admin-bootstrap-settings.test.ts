import { describe, expect, it, vi } from "vitest";
import {
  initialAdminConfigDigest,
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

type AdminBootstrapMarker = {
  tenantId: string;
  schemaVersion: 1;
  digest: string;
  status: "pending" | "complete";
};

function makeAdminSettings(
    durableStorage = makeMockStorage(),
    put = vi.fn<(key: string, value: string) => Promise<void>>()
        .mockResolvedValue(undefined)) {
  let env = {BLUEPRINTS: {put}} as unknown as Cloudflare.Env;
  let makeInstance = () => {
    let ctx = {
      storage: durableStorage,
      exports: {UserDurableObject: {}},
    } as unknown as DurableObjectState;
    return new AdminSettings(ctx, env);
  };
  return {admin: makeInstance(), durableStorage, makeInstance, put};
}

async function marker(status: AdminBootstrapMarker["status"]): Promise<AdminBootstrapMarker> {
  return {
    tenantId: valid.tenantId,
    schemaVersion: 1,
    digest: await initialAdminConfigDigest(valid),
    status,
  };
}

const expectedConfig = {...DEFAULT_ADMIN_CONFIG, ...toAdminConfigPatch(valid)};

describe("AdminSettings.ensureInitialAdminConfig", () => {
  it("initializes fresh authoritative state and its KV mirror", async () => {
    let {admin, durableStorage, put} = makeAdminSettings();

    await admin.ensureInitialAdminConfig(valid);

    expect(admin.getAdminConfig()).toEqual(expectedConfig);
    expect(put).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledWith(ADMIN_CONFIG_KEY, serializeAdminConfig(expectedConfig));
    expect(durableStorage.kv.get("adminBootstrapMarker")).toEqual(await marker("complete"));
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

  it("resumes a matching pending initialization after restart before the KV write", async () => {
    let {durableStorage, makeInstance, put} = makeAdminSettings();
    let pending = await marker("pending");
    durableStorage.transactionSync(() => {
      durableStorage.kv.put("adminConfig", expectedConfig);
      durableStorage.kv.put("adminBootstrapMarker", pending);
    });

    let restartedAdmin = makeInstance();
    await restartedAdmin.ensureInitialAdminConfig(valid);

    expect(put).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledWith(ADMIN_CONFIG_KEY, serializeAdminConfig(expectedConfig));
    expect(durableStorage.kv.get("adminBootstrapMarker")).toEqual(await marker("complete"));
  });

  it("resumes a matching pending initialization after restart following KV success", async () => {
    let {admin, durableStorage, makeInstance, put} = makeAdminSettings();
    let transactionSync = durableStorage.transactionSync.bind(durableStorage);
    let transactionSpy = vi.spyOn(durableStorage, "transactionSync")
        .mockImplementationOnce(transactionSync)
        .mockImplementationOnce(() => { throw new Error("Durable Object restarted"); });

    await expect(admin.ensureInitialAdminConfig(valid)).rejects.toThrow("Durable Object restarted");
    expect(put).toHaveBeenCalledOnce();
    expect(durableStorage.kv.get("adminBootstrapMarker")).toEqual(await marker("pending"));
    transactionSpy.mockRestore();

    let restartedAdmin = makeInstance();
    await restartedAdmin.ensureInitialAdminConfig(valid);

    expect(put).toHaveBeenCalledTimes(2);
    expect(durableStorage.kv.get("adminBootstrapMarker")).toEqual(await marker("complete"));
  });

  it("rejects a differing payload while initialization is pending", async () => {
    let {durableStorage, makeInstance, put} = makeAdminSettings();
    durableStorage.kv.put("adminConfig", expectedConfig);
    durableStorage.kv.put("adminBootstrapMarker", await marker("pending"));

    let restartedAdmin = makeInstance();
    await expect(restartedAdmin.ensureInitialAdminConfig({
      ...valid,
      config: {...valid.config, siteName: "Other OS"},
    })).rejects.toThrow(/different configuration/i);

    expect(restartedAdmin.getAdminConfig()).toEqual(expectedConfig);
    expect(durableStorage.kv.get("adminBootstrapMarker")).toEqual(await marker("pending"));
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects pending initialization whose authoritative config is inconsistent", async () => {
    let {durableStorage, makeInstance, put} = makeAdminSettings();
    durableStorage.kv.put("adminConfig", {
      ...expectedConfig,
      announcement: "Unexpected mutation",
    });
    durableStorage.kv.put("adminBootstrapMarker", await marker("pending"));

    let restartedAdmin = makeInstance();
    await expect(restartedAdmin.ensureInitialAdminConfig(valid)).rejects.toThrow(/inconsistent/i);

    expect(durableStorage.kv.get("adminBootstrapMarker")).toEqual(await marker("pending"));
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects unmarked non-default authoritative state after restart", async () => {
    let {durableStorage, makeInstance, put} = makeAdminSettings();
    let existing = {...DEFAULT_ADMIN_CONFIG, announcement: "Configured by an admin"};
    durableStorage.kv.put("adminConfig", existing);

    let restartedAdmin = makeInstance();
    await expect(restartedAdmin.ensureInitialAdminConfig(valid)).rejects.toThrow(/unmarked/i);

    expect(restartedAdmin.getAdminConfig()).toEqual(existing);
    expect(durableStorage.kv.get("adminBootstrapMarker")).toBeUndefined();
    expect(put).not.toHaveBeenCalled();
  });

  it("transactionally restores the exact prior state when the KV mirror write fails", async () => {
    let {admin, durableStorage, put} = makeAdminSettings();
    let transactionSync = vi.spyOn(durableStorage, "transactionSync");
    put.mockRejectedValueOnce(new Error("KV unavailable"));

    await expect(admin.ensureInitialAdminConfig(valid)).rejects.toThrow("KV unavailable");

    expect(admin.getAdminConfig()).toEqual(DEFAULT_ADMIN_CONFIG);
    expect(durableStorage.kv.get("adminBootstrapMarker")).toBeNull();
    expect(transactionSync).toHaveBeenCalledTimes(2);

    await admin.ensureInitialAdminConfig(valid);
    expect(durableStorage.kv.get("adminBootstrapMarker")).toEqual(await marker("complete"));
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
    expect(durableStorage.kv.get<AdminBootstrapMarker>("adminBootstrapMarker"))
        .toEqual(await marker("complete"));
  });
});
