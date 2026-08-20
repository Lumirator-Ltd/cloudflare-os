// The one endpoint this connector talks to, as the deployment administrator configured it.
//
// The endpoint being a deployment setting rather than user input is what separates this connector
// from the generic one: there is no user-supplied URL or connect form, a grant is scoped to one
// upstream server rather than the portal as a whole, and an unconfigured deployment hides the
// connector instead of offering a dead end. See the README.

import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import type { ConnectedServer } from "@gadgets/mcp-shared/account";
import { sameEndpoint, type ToolScope } from "@gadgets/mcp-shared/scope";
import { fetchOptions } from "@gadgets/mcp-shared/fetch";
import type { ServerTrust } from "@gadgets/mcp-shared/tools";

/** The configured portal, once the deployment's vars have been read and validated. */
export type PortalConfig = {
  /** The portal's MCP endpoint URL (Streamable HTTP). */
  endpoint: string;
  /** Display name shown in the connector list and in every approval prompt. */
  name: string;
  /** This connector always authenticates each user through OAuth. */
  auth: "oauth";
};

/** Stable id used in binding names, action kinds, and generated type names. */
export const PORTAL_SERVER_ID = "portal";

/**
 * Whether this portal's tool annotations may drive auto-approval. Off unless a deployment asserts
 * that the upstreams are trusted, since a portal relays annotations written by servers the
 * administrator never reviewed.
 *
 * Call it at the point of use, every time. Persisting the answer would leave accounts vetted after
 * an administrator withdrew the assertion, until each one reconnected.
 */
export function portalTrust(env: Env): ServerTrust {
  return (env.MCP_PORTAL_TRUST_ANNOTATIONS ?? "").toLowerCase() === "true" ? "vetted" : "byo";
}

/**
 * Reads the deployment's portal configuration, or null when it is not configured. A missing or
 * unusable `MCP_PORTAL_URL` returns null rather than throwing, so the connector advertises no
 * resources and the Workshop hides it.
 */
export function readPortalConfig(env: Env): PortalConfig | null {
  const raw = env.MCP_PORTAL_URL?.trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // The same rule `guardedFetch` applies anyway. Enforcing it here means an `http://` typo hides the
  // connector rather than failing on the first request, with an error naming a URL the user never
  // saw.
  if (url.protocol !== "https:" && !(fetchOptions(env).allowInsecure && url.protocol === "http:")) {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;

  return {
    endpoint: url.toString(),
    name: env.MCP_PORTAL_NAME?.trim() || `MCP Server Portal (${url.host})`,
    auth: "oauth",
  };
}

/** Refuses a connected server that the portal's current OAuth-only policy no longer permits. */
export function assertPortalServerAvailable(
  config: PortalConfig | null, server: ConnectedServer,
): void {
  if (config && sameEndpoint(config.endpoint, server.endpoint) && server.auth === "oauth") return;
  throw new Error(
    "This MCP portal connection is no longer available. Reconnect the account.");
}

/**
 * Refuses a grant that does not name one upstream server.
 *
 * A portal flattens many systems behind one endpoint, so a scope with no `serverId` is a grant over
 * all of them at once -- `scopeAllows` permits every tool that is not portal-native -- and that is
 * the one breadth this connector deliberately does not offer.
 *
 * This is the enforcement, not the configurator. The form refuses to *emit* such a URL, but a
 * resource URL is not only ever produced by the form: an agent passes a concrete one to
 * `requestConnection`, and any URL under the portal's origin reaches `getGatekeeperClassFor`. A
 * rule that lives only in the iframe is a suggestion; the facet is minted here.
 */
export function requirePortalServerScope(scope: ToolScope): void {
  if (scope.serverId !== undefined) return;
  throw new Error(
    "A portal grant has to name one of the servers behind the portal. Granting the portal itself " +
    "would cover every system connected to it, including ones added later.");
}

/** The single resource type this connector offers, scoped to the configured portal's origin. */
export function portalResource(config: PortalConfig): SupportedResource {
  return {
    // Origin-scoped, so a resource URL for anything else matches nothing this connector offers.
    urlPattern: `${new URL(config.endpoint).origin}/*`,
    title: config.name,
    description:
      "Tools from the servers behind this portal. Writes need approval.",
  };
}

/**
 * The connected-server record stored on an account, derived entirely from configuration.
 * `provenance` is what keeps the far side from renaming itself over `MCP_PORTAL_NAME` in every
 * approval prompt (see `McpAccountBase.complete`).
 */
export function portalServer(config: PortalConfig): ConnectedServer {
  return {
    endpoint: config.endpoint,
    provenance: "deployment",
    auth: config.auth,
    serverId: PORTAL_SERVER_ID,
    serverName: config.name,
  };
}
