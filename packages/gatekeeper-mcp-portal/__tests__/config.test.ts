import { describe, expect, it } from "vitest";
import type { ConnectedServer, ServerAuthKind } from "@gadgets/mcp-shared/account";
import {
  assertPortalServerAvailable,
  portalResource,
  portalServer,
  portalTrust,
  readPortalConfig,
  requirePortalServerScope,
} from "../src/config.js";

function env(overrides: Record<string, string> = {}): Env {
  return overrides as unknown as Env;
}

describe("readPortalConfig", () => {
  it("returns null when unconfigured, so the connector hides itself", () => {
    // Advertising no resources is how the Workshop drops a vendor. A connector that appears in the
    // list and then errors when clicked would be the worse failure.
    expect(readPortalConfig(env())).toBeNull();
    expect(readPortalConfig(env({ MCP_PORTAL_URL: "   " }))).toBeNull();
  });

  it("returns null for an unparseable or non-HTTP URL", () => {
    // An administrator-set URL is trusted, but a typo that produced a non-HTTP scheme should not
    // reach `fetch`.
    expect(readPortalConfig(env({ MCP_PORTAL_URL: "not a url" }))).toBeNull();
    expect(readPortalConfig(env({ MCP_PORTAL_URL: "file:///etc/passwd" }))).toBeNull();
    expect(readPortalConfig(env({ MCP_PORTAL_URL: "javascript:alert(1)" }))).toBeNull();
  });

  it.each([
    "https://admin:secret@gw.example.com/mcp",
    "https://admin@gw.example.com/mcp",
    "https://gw.example.com/mcp?tenant=acme",
    "https://gw.example.com/mcp#server",
  ])("rejects an endpoint containing userinfo, query, or fragment: %s", endpoint => {
    expect(readPortalConfig(env({ MCP_PORTAL_URL: endpoint }))).toBeNull();
  });

  it("reads a clean endpoint and display name", () => {
    const defaulted = readPortalConfig(env({ MCP_PORTAL_URL: "https://gw.example.com/mcp" }));
    expect(defaulted?.endpoint).toBe("https://gw.example.com/mcp");
    expect(defaulted?.name).toBe("MCP Server Portal (gw.example.com)");
    expect(defaulted?.auth).toBe("oauth");

    const configured = readPortalConfig(env({
      MCP_PORTAL_URL: "https://gw.example.com/mcp",
      MCP_PORTAL_NAME: "Cloudflare MCP Portal",
    }));
    expect(configured?.name).toBe("Cloudflare MCP Portal");
  });

  it.each(["token", "none"])(
    "stays OAuth-only when legacy MCP_PORTAL_AUTH is %s",
    auth => {
      expect(readPortalConfig(env({
        MCP_PORTAL_URL: "https://gw.example.com/mcp",
        MCP_PORTAL_AUTH: auth,
        MCP_PORTAL_TOKEN: "legacy-secret",
      }))?.auth).toBe("oauth");
    },
  );

  it("does not let MCP_PORTAL_TOKEN alter OAuth-only authentication", () => {
    expect(readPortalConfig(env({
      MCP_PORTAL_URL: "https://gw.example.com/mcp",
      MCP_PORTAL_TOKEN: "legacy-secret",
    }))?.auth).toBe("oauth");
  });

  it("permits http only where guardedFetch would, which is local development", () => {
    // The URL is not user input, so there is no untrusted party to keep away from private hosts --
    // but `guardedFetch` still refuses plain http without the insecure flag. Accepting it here would
    // produce a connector that appears in the list, takes a connect click, and then fails on its
    // first request over a URL the user never saw. Hiding it says the same thing at the right time.
    expect(readPortalConfig(env({ MCP_PORTAL_URL: "http://localhost:9000/mcp" }))).toBeNull();
    expect(readPortalConfig(env({
      MCP_PORTAL_URL: "http://localhost:9000/mcp",
      MCP_ALLOW_INSECURE: "true",
    }))?.endpoint).toBe("http://localhost:9000/mcp");
  });
});

describe("assertPortalServerAvailable", () => {
  const config = readPortalConfig(env({ MCP_PORTAL_URL: "https://gw.example.com/mcp" }))!;
  const server = (auth: ServerAuthKind): ConnectedServer => ({
    endpoint: config.endpoint,
    provenance: "deployment",
    auth,
    serverId: "portal",
    serverName: config.name,
  });

  it.each(["none", "token"] as const)(
    "rejects a current portal endpoint using legacy %s authentication",
    auth => {
      expect(() => assertPortalServerAvailable(config, server(auth))).toThrowError(
        /^This MCP portal connection is no longer available\. Reconnect the account\.$/,
      );
    },
  );

  it("accepts a current portal endpoint using OAuth", () => {
    expect(() => assertPortalServerAvailable(config, server("oauth"))).not.toThrow();
  });
});

describe("portalResource", () => {
  const config = readPortalConfig(env({
    MCP_PORTAL_URL: "https://gw.example.com/mcp",
    MCP_PORTAL_NAME: "Acme Portal",
  }))!;

  it("scopes the resource to the portal's origin", () => {
    // Origin-scoped, so a resource URL for any other host matches nothing this connector offers.
    expect(portalResource(config).urlPattern).toBe("https://gw.example.com/*");
    expect(portalResource(config).title).toBe("Acme Portal");
  });
});

describe("portalTrust", () => {
  it("does not trust upstream annotations just because an administrator chose the portal", () => {
    // A portal aggregates servers the administrator did not write. Auto-approval keys off annotations
    // those upstreams supply, so choosing the portal must not silently vouch for all of them.
    expect(portalTrust(env({ MCP_PORTAL_URL: "https://gw.example.com/mcp" }))).toBe("byo");
  });

  it("requires the exact opt-in, so a stray value is not an assertion", () => {
    expect(portalTrust(env({ MCP_PORTAL_TRUST_ANNOTATIONS: "true" }))).toBe("vetted");
    expect(portalTrust(env({ MCP_PORTAL_TRUST_ANNOTATIONS: "TRUE" }))).toBe("vetted");
    for (const value of ["1", "yes", "on", "vetted", ""]) {
      expect(portalTrust(env({ MCP_PORTAL_TRUST_ANNOTATIONS: value }))).toBe("byo");
    }
  });

  it("takes effect immediately when withdrawn", () => {
    // The tier is read at each point of use rather than stored on the account or a binding's props.
    // It used to be frozen at connect time, so turning the assertion off left every existing account
    // vetted until it happened to reconnect -- the wrong direction for a security setting to stick.
    const vetted = env({ MCP_PORTAL_TRUST_ANNOTATIONS: "true" });
    expect(portalTrust(vetted)).toBe("vetted");
    expect(portalTrust(env())).toBe("byo");
  });
});

describe("portalServer", () => {
  it("records provenance, which is permanent, and not the trust tier, which is not", () => {
    // Provenance answers "who chose this endpoint" and is settled forever once the account connects.
    // The trust tier answers "what may its annotations do today" and is configuration. The bug this
    // pins: with `trust` doing double duty, a portal left at the default `byo` counted as
    // user-supplied, so the upstream could rename itself over MCP_PORTAL_NAME in every prompt.
    const config = readPortalConfig(env({
      MCP_PORTAL_URL: "https://gw.example.com/mcp",
      MCP_PORTAL_NAME: "Acme Portal",
    }))!;
    expect(portalServer(config).provenance).toBe("deployment");
    expect(portalServer(config)).not.toHaveProperty("trust");
    expect(portalServer(config).serverName).toBe("Acme Portal");
  });
});

describe("requirePortalServerScope", () => {
  it("refuses a grant that names no upstream server", () => {
    // The hole this closes. An empty scope is the whole portal: `scopeAllows` permits every tool
    // that is not portal-native, across every system connected to it, including ones added later.
    // The configurator will not build such a URL, but the configurator is not what mints the facet
    // -- an agent passes its own `resourceUrl` to `requestConnection`, and any URL under the
    // portal's origin gets here.
    expect(() => requirePortalServerScope({})).toThrow(/name one of the servers/);
  });

  it("refuses a tool pin with no server, which is not a shape this connector offers", () => {
    // Narrow, but unanchored. Every documented grant here is `#server=<id>` with an optional tool
    // pin refining it, and the boundary should accept exactly the shapes the form can produce.
    expect(() => requirePortalServerScope({ tools: ["gh_a"] })).toThrow(/name one of the servers/);
  });

  it("accepts a server scope, with or without a tool pin", () => {
    expect(() => requirePortalServerScope({ serverId: "github" })).not.toThrow();
    expect(() => requirePortalServerScope({ serverId: "github", tools: ["github_a"] }))
      .not.toThrow();
    // Pinned-and-empty denies everything, which is fail-closed and fine to mint.
    expect(() => requirePortalServerScope({ serverId: "github", tools: [] })).not.toThrow();
  });
});
