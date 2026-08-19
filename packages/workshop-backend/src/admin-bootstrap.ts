import {
  MAX_SITE_NAME_LENGTH,
  isAmbientGatekeeperMode,
  isHexColor,
} from "@gadgets/workshop-shared/api";
import type { AdminConfig } from "./admin-config.js";

const MAX_TENANT_ID_LENGTH = 128;
const CONTEXT_VENDOR_ID = "context";
const CUSTOM_VENDOR_ID = "custom";

/** The complete, closed schema accepted for initial deployment configuration. */
export type InitialAdminConfigV1 = {
  tenantId: string;
  schemaVersion: 1;
  /**
   * One-time proof authorizing adoption of unmarked legacy AdminSettings state.
   * Excluded from the canonical bootstrap digest so it can be omitted after adoption.
   */
  adoptExistingConfigDigest?: string;
  config: {
    siteName: string;
    accentColor: string;
    contextGatekeeper: "disabled" | "optional" | "enabled";
    customGatekeeper: "disabled" | "optional" | "enabled";
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  let keys = Object.keys(value);
  return keys.length === allowed.length && keys.every(key => allowed.includes(key));
}

function hasRequiredAndOptionalKeys(
    value: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[]): boolean {
  let keys = Object.keys(value);
  let allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key)) &&
      keys.every(key => allowed.has(key));
}

/** Validates and copies an initial admin configuration, returning null for any unsupported input. */
export function parseInitialAdminConfig(value: unknown): InitialAdminConfigV1 | null {
  if (!isRecord(value) || !hasRequiredAndOptionalKeys(
    value,
    ["tenantId", "schemaVersion", "config"],
    ["adoptExistingConfigDigest"],
  )) {
    return null;
  }
  if (typeof value.tenantId !== "string" || value.tenantId.length === 0 ||
      value.tenantId.length > MAX_TENANT_ID_LENGTH || value.schemaVersion !== 1 ||
      (value.adoptExistingConfigDigest !== undefined &&
        (typeof value.adoptExistingConfigDigest !== "string" ||
          !/^[0-9a-f]{64}$/.test(value.adoptExistingConfigDigest))) ||
      !isRecord(value.config) || !hasOnlyKeys(value.config, [
        "siteName",
        "accentColor",
        "contextGatekeeper",
        "customGatekeeper",
      ])) {
    return null;
  }

  let config = value.config;
  if (typeof config.siteName !== "string" || config.siteName.length > MAX_SITE_NAME_LENGTH ||
      !isHexColor(config.accentColor) ||
      !isAmbientGatekeeperMode(config.contextGatekeeper) ||
      !isAmbientGatekeeperMode(config.customGatekeeper)) {
    return null;
  }

  return {
    tenantId: value.tenantId,
    schemaVersion: 1,
    ...(value.adoptExistingConfigDigest === undefined
      ? {}
      : {adoptExistingConfigDigest: value.adoptExistingConfigDigest}),
    config: {
      siteName: config.siteName,
      accentColor: config.accentColor,
      contextGatekeeper: config.contextGatekeeper,
      customGatekeeper: config.customGatekeeper,
    },
  };
}

function canonicalInitialAdminConfig(value: InitialAdminConfigV1): string {
  return JSON.stringify({
    tenantId: value.tenantId,
    schemaVersion: value.schemaVersion,
    config: {
      siteName: value.config.siteName,
      accentColor: value.config.accentColor,
      contextGatekeeper: value.config.contextGatekeeper,
      customGatekeeper: value.config.customGatekeeper,
    },
  });
}

/** Returns the lowercase SHA-256 digest of the canonical version 1 payload. */
async function sha256(value: string): Promise<string> {
  let bytes = new TextEncoder().encode(value);
  let digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function adminConfigAdoptionDigest(
    tenantId: string,
    serializedAdminConfig: string): Promise<string> {
  return sha256(JSON.stringify({
    purpose: "cloudflare-os-admin-config-adoption-v1",
    tenantId,
    serializedAdminConfig,
  }));
}

export function initialAdminConfigDigest(value: InitialAdminConfigV1): Promise<string> {
  return sha256(canonicalInitialAdminConfig(value));
}

/** Converts a validated payload into the restricted deployment admin configuration patch. */
export function toAdminConfigPatch(value: InitialAdminConfigV1): Partial<AdminConfig> {
  return {
    siteName: value.config.siteName,
    accentColor: value.config.accentColor,
    ambientGatekeeperModes: {
      [CONTEXT_VENDOR_ID]: value.config.contextGatekeeper,
      [CUSTOM_VENDOR_ID]: value.config.customGatekeeper,
    },
  };
}
