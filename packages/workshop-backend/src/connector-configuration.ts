import type {
  AdminConnectorConfiguration,
  AdminConnectorConfigurationValues,
} from "@gadgets/workshop-shared/api";
import type {
  ConnectorConfigurationInput,
  GatekeeperVendor,
} from "@gadgets/workshop-shared/gatekeeper";
import { buildGatekeeperVendorMap } from "./auth/auth-vendors.js";
import { createWorkshopLogger } from "./observability.js";

const logger = createWorkshopLogger("workshop.connector.configuration");

const STATIC_OAUTH_INPUTS = Object.freeze([
  Object.freeze({ name: "CLIENT_ID", label: "Client ID", secret: true as const }),
  Object.freeze({ name: "CLIENT_SECRET", label: "Client Secret", secret: true as const }),
]);

const CONNECTOR_SECRET_INPUTS = Object.freeze({
  cloudflare: STATIC_OAUTH_INPUTS,
  confluence: STATIC_OAUTH_INPUTS,
  github: STATIC_OAUTH_INPUTS,
  google: STATIC_OAUTH_INPUTS,
  linear: STATIC_OAUTH_INPUTS,
  notion: STATIC_OAUTH_INPUTS,
  slack: STATIC_OAUTH_INPUTS,
  spotify: STATIC_OAUTH_INPUTS,
  supabase: STATIC_OAUTH_INPUTS,
  zoominfo: STATIC_OAUTH_INPUTS,
});

type ConfigurableConnectorId = keyof typeof CONNECTOR_SECRET_INPUTS;

function canonicalInputs(vendorId: string): readonly ConnectorConfigurationInput[] | undefined {
  return CONNECTOR_SECRET_INPUTS[vendorId as ConfigurableConnectorId];
}
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
const WORKER_PREFIX_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_SECRET_LENGTH = 4096;
const SETUP_UNAVAILABLE_ERROR =
  "Connector configuration writes are not available on this deployment.";

function writeFailureMessage(written: number, status?: number): string {
  const statusDetail = status === undefined ? "" : ` (Cloudflare API status ${status})`;
  const partialDetail = written === 0
    ? ""
    : " The connector may have been partially updated; retry with the same values.";
  return `Connector configuration request failed${statusDetail}.${partialDetail}`;
}

function publicBaseUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
        parsed.username || parsed.password || parsed.search || parsed.hash) {
      return null;
    }
    return value.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

type WriteSetup = {
  accountId: string;
  workerPrefix: string;
  apiToken: string;
};

function writeSetup(env: Cloudflare.Env): WriteSetup | null {
  const accountId = env.CONNECTOR_CONFIG_ACCOUNT_ID;
  const workerPrefix = env.CONNECTOR_CONFIG_WORKER_PREFIX;
  const apiToken = env.CONNECTOR_CONFIG_API_TOKEN;
  if (!accountId || !ACCOUNT_ID_PATTERN.test(accountId) ||
      !workerPrefix || !WORKER_PREFIX_PATTERN.test(workerPrefix) ||
      !apiToken || !apiToken.trim() || !publicBaseUrl(env.PUBLIC_BASE_URL)) {
    return null;
  }
  return { accountId, workerPrefix, apiToken };
}

function callbackUrl(env: Cloudflare.Env, vendorId: string): string {
  const baseUrl = publicBaseUrl(env.PUBLIC_BASE_URL);
  return baseUrl ? `${baseUrl}/gatekeeper/${vendorId}/oauth` : "";
}

async function configurableInputs(
  vendors: Map<string, Service<GatekeeperVendor>>,
  vendorId: string,
): Promise<readonly ConnectorConfigurationInput[]> {
  const vendor = vendors.get(vendorId);
  const inputs = canonicalInputs(vendorId);
  if (!vendor || !inputs || !(await vendor.describe()).configuration) {
    throw new Error(`Connector "${vendorId}" is not configurable.`);
  }
  return inputs;
}

function isPrintable(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}

function validateValues(
  inputs: readonly ConnectorConfigurationInput[],
  values: AdminConnectorConfigurationValues,
): void {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("Connector configuration values must be an object.");
  }
  const allowed = new Set(inputs.map(input => input.name));
  for (const name of Object.keys(values)) {
    if (!allowed.has(name)) throw new Error(`Unexpected connector input: ${name}.`);
  }
  for (const { name } of inputs) {
    if (!Object.prototype.hasOwnProperty.call(values, name)) {
      throw new Error(`Missing connector input: ${name}.`);
    }
    const value = values[name];
    if (typeof value !== "string" || value.length === 0 ||
        value.length > MAX_SECRET_LENGTH || !isPrintable(value)) {
      throw new Error(`Invalid connector input: ${name}.`);
    }
  }
}

/** Lists bound static-OAuth connectors without reading back any secret values. */
export async function listConnectorConfigurations(
  env: Cloudflare.Env,
): Promise<AdminConnectorConfiguration[]> {
  const vendors = buildGatekeeperVendorMap(env);
  const results: AdminConnectorConfiguration[] = [];
  const writeAvailable = writeSetup(env) !== null;
  for (const [id, vendor] of vendors) {
    const inputs = canonicalInputs(id);
    if (!inputs) continue;
    try {
      const description = await vendor.describe();
      if (!description.configuration) continue;
      results.push({
        id,
        displayName: description.displayName,
        logo: description.logo,
        configured: description.configuration.configured,
        callbackUrl: callbackUrl(env, id),
        inputs: inputs.map(input => ({ ...input })),
        writeAvailable,
      });
    } catch {
      logger.warn("failed to describe configurable connector", {
        event: "connector.configuration.describe.failed", vendorId: id,
      });
    }
  }
  return results;
}

/** Validates and writes every declared connector secret through Cloudflare's Workers API. */
export async function configureConnector(
  env: Cloudflare.Env,
  vendorId: string,
  values: AdminConnectorConfigurationValues,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const setup = writeSetup(env);
  if (!setup) throw new Error(SETUP_UNAVAILABLE_ERROR);

  const inputs = await configurableInputs(buildGatekeeperVendorMap(env), vendorId);
  validateValues(inputs, values);
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${setup.accountId}/workers/scripts/` +
    `${setup.workerPrefix}${vendorId}/secrets`;

  let written = 0;
  for (const input of inputs) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${setup.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: input.name,
          text: values[input.name],
          type: "secret_text",
        }),
      });
    } catch {
      throw new Error(writeFailureMessage(written));
    }
    if (!response.ok) {
      throw new Error(writeFailureMessage(written, response.status));
    }
    written++;
  }
}
