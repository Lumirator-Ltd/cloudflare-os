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

/** Validates and copies an initial admin configuration, returning null for any unsupported input. */
export function parseInitialAdminConfig(value: unknown): InitialAdminConfigV1 | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["tenantId", "schemaVersion", "config"])) {
    return null;
  }
  if (typeof value.tenantId !== "string" || value.tenantId.length === 0 ||
      value.tenantId.length > MAX_TENANT_ID_LENGTH || value.schemaVersion !== 1 ||
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
export async function initialAdminConfigDigest(value: InitialAdminConfigV1): Promise<string> {
  let bytes = new TextEncoder().encode(canonicalInitialAdminConfig(value));
  let digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
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
