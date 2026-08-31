import { MAX_SITE_NAME_LENGTH } from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";
import {
  adminConfigAdoptionDigest,
  initialAdminConfigDigest,
  parseInitialAdminConfig,
  toAdminConfigPatch,
} from "../src/admin-bootstrap.js";

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

const adoptionDigest = "a".repeat(64);
const validWithAdoption = {
  ...valid,
  adoptExistingConfigDigest: adoptionDigest,
} as const;

describe("parseInitialAdminConfig", () => {
  it("accepts the closed version 1 payload with or without an adoption proof", () => {
    expect(parseInitialAdminConfig(valid)).toEqual(valid);
    expect(parseInitialAdminConfig(validWithAdoption)).toEqual(validWithAdoption);
  });

  it("rejects malformed adoption proofs", () => {
    for (const digest of ["", "A".repeat(64), "g".repeat(64), "a".repeat(63), "a".repeat(65)]) {
      expect(parseInitialAdminConfig({
        ...valid,
        adoptExistingConfigDigest: digest,
      })).toBeNull();
    }
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
  it("shares the deployment pipeline's purpose- and tenant-bound adoption vector", async () => {
    await expect(adminConfigAdoptionDigest(
      "tenant-immutable-id",
      '{"signupsEnabled":true}',
    )).resolves.toBe("bb8ff4e29138d0f10b548133f892ce2384e0dc73c2289a0f651569db9fc59abf");
  });

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
    await expect(initialAdminConfigDigest(validWithAdoption))
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
