import { describe, expect, it, vi } from "vitest";
import type { AdminSettings } from "../src/admin-settings.js";
import { AdminApiImpl } from "../src/admin-settings.js";

const calls: Record<string, unknown[]> = {
  getSettings: [],
  setSignupsEnabled: [true],
  setSiteName: ["Workshop"],
  setSiteLogo: [null],
  setInstanceInstructions: [""],
  setResourceEnabled: ["test", "https://example.com/*", true],
  setGatekeeperMode: ["test", "enabled"],
  setAnnouncement: [""],
  setBanner: ["", "info"],
  setAccentColor: [""],
  isBlueprintFeatured: ["blueprint"],
  setBlueprintFeatured: ["blueprint", true],
  promoteFormat: ["blueprint"],
  removeFormat: ["blueprint"],
  updateFormat: ["blueprint", {}],
  setFormatOrder: [[]],
};

describe("retained AdminApi authority", () => {
  it("awaits its authorization guard before every public operation", async () => {
    const forwarded = vi.fn().mockResolvedValue(undefined);
    const admin = new Proxy({}, { get: () => forwarded }) as DurableObjectStub<AdminSettings>;
    const publicMethods = Object.getOwnPropertyNames(AdminApiImpl.prototype)
      .filter(method => method !== "constructor").toSorted();
    expect(publicMethods).toEqual(Object.keys(calls).toSorted());

    for (const [method, args] of Object.entries(calls)) {
      const authorize = vi.fn().mockRejectedValue(new Error("authority revoked"));
      const api = new AdminApiImpl(admin, "stable-user-id", authorize);

      await expect(Reflect.apply(
        (api as unknown as Record<string, (...values: unknown[]) => unknown>)[method], api, args,
      )).rejects.toThrow("authority revoked");
      expect(authorize).toHaveBeenCalledOnce();
      expect(forwarded).not.toHaveBeenCalled();
    }
  });

  it("forwards an unchanged admin operation after the guard succeeds", async () => {
    const view = { signupsEnabled: true };
    const getSettings = vi.fn().mockResolvedValue(view);
    const admin = { getSettings } as unknown as DurableObjectStub<AdminSettings>;
    const authorize = vi.fn().mockResolvedValue(undefined);
    const api = new AdminApiImpl(admin, "stable-user-id", authorize);

    await expect(api.getSettings()).resolves.toBe(view);
    expect(authorize).toHaveBeenCalledOnce();
    expect(getSettings).toHaveBeenCalledExactlyOnceWith("stable-user-id");
  });
});
