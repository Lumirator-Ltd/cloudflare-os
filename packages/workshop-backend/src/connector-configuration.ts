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
  Object.freeze({ name: "CLIENT_ID", label: "Client ID", secret: true }),
  Object.freeze({ name: "CLIENT_SECRET", label: "Client Secret", secret: true }),
]);

const MCP_PORTAL_INPUTS = Object.freeze([
  Object.freeze({ name: "MCP_PORTAL_URL", label: "Portal URL", secret: false }),
]);

const README_BASE_URL =
  "https://github.com/Lumirator-Ltd/cloudflare-os/tree/main/packages";

type ConnectorDescriptor = {
  inputs: readonly ConnectorConfigurationInput[];
  setupGuideUrl: string;
  workerSuffix: string;
  showCallback: boolean;
};

const CONNECTOR_DESCRIPTORS = Object.freeze({
  cloudflare: Object.freeze({
    inputs: STATIC_OAUTH_INPUTS,
    setupGuideUrl: `${README_BASE_URL}/gatekeeper-cloudflare#readme`,
    workerSuffix: "cloudflare",
    showCallback: true,
  }),
  confluence: Object.freeze({
    inputs: STATIC_OAUTH_INPUTS,
    setupGuideUrl: `${README_BASE_URL}/gatekeeper-confluence#readme`,
    workerSuffix: "confluence",
    showCallback: true,
  }),
  github: Object.freeze({
    inputs: STATIC_OAUTH_INPUTS,
    setupGuideUrl: `${README_BASE_URL}/gatekeeper-github#readme`,
    workerSuffix: "github",
    showCallback: true,
  }),
  google: Object.freeze({
    inputs: STATIC_OAUTH_INPUTS,
    setupGuideUrl: `${README_BASE_URL}/gatekeeper-google#readme`,
    workerSuffix: "google",
    showCallback: true,
  }),
  hubspot: Object.freeze({
    inputs: STATIC_OAUTH_INPUTS,
    setupGuideUrl: `${README_BASE_URL}/gatekeeper-hubspot#readme`,
    workerSuffix: "hubspot",
    showCallback: true,
  }),
  linear: Object.freeze({
    inputs: STATIC_OAUTH_INPUTS,
    setupGuideUrl: "https://linear.app/developers/oauth-2-0-authentication",
    workerSuffix: "linear",
    showCallback: true,
  }),
  mcp_portal: Object.freeze({
    inputs: MCP_PORTAL_INPUTS,
    setupGuideUrl:
      "https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/",
    workerSuffix: "mcp-portal",
    showCallback: false,
  }),
  notion: Object.freeze({
    inputs: STATIC_OAUTH_INPUTS,
    setupGuideUrl: `${README_BASE_URL}/gatekeeper-notion#readme`,
    workerSuffix: "notion",
    showCallback: true,
  }),
  slack: Object.freeze({
    inputs: STATIC_OAUTH_INPUTS,
    setupGuideUrl: `${README_BASE_URL}/gatekeeper-slack#readme`,
    workerSuffix: "slack",
    showCallback: true,
  }),
  spotify: Object.freeze({
    inputs: STATIC_OAUTH_INPUTS,
    setupGuideUrl: `${README_BASE_URL}/gatekeeper-spotify#readme`,
    workerSuffix: "spotify",
    showCallback: true,
  }),
  supabase: Object.freeze({
    inputs: STATIC_OAUTH_INPUTS,
    setupGuideUrl: `${README_BASE_URL}/gatekeeper-supabase#readme`,
    workerSuffix: "supabase",
    showCallback: true,
  }),
  zoominfo: Object.freeze({
    inputs: STATIC_OAUTH_INPUTS,
    setupGuideUrl: `${README_BASE_URL}/gatekeeper-zoominfo#readme`,
    workerSuffix: "zoominfo",
    showCallback: true,
  }),
} satisfies Record<string, ConnectorDescriptor>);

type ConfigurableConnectorId = keyof typeof CONNECTOR_DESCRIPTORS;

function connectorDescriptor(vendorId: string): ConnectorDescriptor | undefined {
  if (!Object.prototype.hasOwnProperty.call(CONNECTOR_DESCRIPTORS, vendorId)) return undefined;
  return CONNECTOR_DESCRIPTORS[vendorId as ConfigurableConnectorId];
}

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
const WORKER_PREFIX_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_CONFIGURED_VALUE_LENGTH = 4096;
const SETUP_UNAVAILABLE_ERROR =
  "Connector configuration writes are not available on this deployment.";
const DISCOVERY_ERROR = "Connector configuration could not be discovered.";

function writeFailureMessage(status?: number): string {
  const statusDetail = status === undefined ? "" : ` (Cloudflare API status ${status})`;
  return `Connector configuration request failed${statusDetail}. ` +
    "The connector credentials may have been partially updated; retry with the same values.";
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

async function assertConfigurable(
  vendors: Map<string, Service<GatekeeperVendor>>,
  vendorId: string,
): Promise<void> {
  const vendor = vendors.get(vendorId);
  if (!vendor) {
    throw new Error("Connector is not configurable.");
  }
  let description;
  try {
    description = await vendor.describe();
  } catch {
    logger.warn("failed to describe configurable connector", {
      event: "connector.configuration.describe.failed", vendorId,
    });
    throw new Error(DISCOVERY_ERROR);
  }
  if (!description.configuration) {
    throw new Error("Connector is not configurable.");
  }
}

function isPrintable(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}

function normalizeMcpPortalUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid connector input: MCP_PORTAL_URL.");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password ||
      value.includes("?") || value.includes("#")) {
    throw new Error("Invalid connector input: MCP_PORTAL_URL.");
  }
  const normalized = parsed.toString();
  if (normalized.length > MAX_CONFIGURED_VALUE_LENGTH) {
    throw new Error("Invalid connector input: MCP_PORTAL_URL.");
  }
  return normalized;
}

function validateValues(
  inputs: readonly ConnectorConfigurationInput[],
  values: AdminConnectorConfigurationValues,
): AdminConnectorConfigurationValues {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("Connector configuration values must be an object.");
  }
  const allowed = new Set(inputs.map(input => input.name));
  for (const name of Object.keys(values)) {
    if (!allowed.has(name)) throw new Error(`Unexpected connector input: ${name}.`);
  }
  const normalized: AdminConnectorConfigurationValues = {};
  for (const { name } of inputs) {
    if (!Object.prototype.hasOwnProperty.call(values, name)) {
      throw new Error(`Missing connector input: ${name}.`);
    }
    const value = values[name];
    if (typeof value !== "string" || value.length === 0 ||
        value.length > MAX_CONFIGURED_VALUE_LENGTH || !isPrintable(value)) {
      throw new Error(`Invalid connector input: ${name}.`);
    }
    normalized[name] = name === "MCP_PORTAL_URL" ? normalizeMcpPortalUrl(value) : value;
  }
  return normalized;
}

/** Lists bound kernel-described connectors without reading back any configured values. */
export async function listConnectorConfigurations(
  env: Cloudflare.Env,
): Promise<AdminConnectorConfiguration[]> {
  const vendors = buildGatekeeperVendorMap(env);
  const results: AdminConnectorConfiguration[] = [];
  const writeAvailable = writeSetup(env) !== null;
  for (const [id, vendor] of vendors) {
    const descriptor = connectorDescriptor(id);
    if (!descriptor) continue;
    try {
      const description = await vendor.describe();
      if (!description.configuration) continue;
      results.push({
        id,
        displayName: description.displayName,
        logo: description.logo,
        configured: description.configuration.configured,
        ...(descriptor.showCallback ? { callbackUrl: callbackUrl(env, id) } : {}),
        setupGuideUrl: descriptor.setupGuideUrl,
        inputs: descriptor.inputs.map(input => ({ ...input })),
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

/** Validates and writes every declared input through Cloudflare's Workers secrets API. */
export async function configureConnector(
  env: Cloudflare.Env,
  vendorId: string,
  values: AdminConnectorConfigurationValues,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const descriptor = connectorDescriptor(vendorId);
  if (!descriptor) throw new Error("Connector is not configurable.");
  const setup = writeSetup(env);
  if (!setup) throw new Error(SETUP_UNAVAILABLE_ERROR);

  await assertConfigurable(buildGatekeeperVendorMap(env), vendorId);
  const normalizedValues = validateValues(descriptor.inputs, values);
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${setup.accountId}/workers/scripts/` +
    `${setup.workerPrefix}${descriptor.workerSuffix}/secrets`;

  for (const input of descriptor.inputs) {
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
          text: normalizedValues[input.name],
          type: "secret_text",
        }),
      });
    } catch {
      throw new Error(writeFailureMessage());
    }
    if (!response.ok) {
      throw new Error(writeFailureMessage(response.status));
    }
  }
}
