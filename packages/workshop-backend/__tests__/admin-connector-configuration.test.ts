import { describe, expect, it, vi } from "vitest";
import type { GatekeeperVendor, VendorDescription } from "@gadgets/workshop-shared/gatekeeper";
import { AdminApiImpl } from "../src/admin-settings.js";

const INPUTS = [
  { name: "CLIENT_ID", label: "Client ID", secret: true as const },
  { name: "CLIENT_SECRET", label: "Client Secret", secret: true as const },
];
const failingFetch: typeof fetch = async () => {
  throw new Error("client-secret-value");
};

function vendor(description: VendorDescription): Service<GatekeeperVendor> {
  return {
    async describe() { return description; },
  } as Service<GatekeeperVendor>;
}

function environment(overrides: Record<string, unknown> = {}): Cloudflare.Env {
  return {
    GATEKEEPER_GITHUB: vendor({
      displayName: "GitHub",
      url: "https://github.com",
      logo: { url: "https://example.com/github.svg" },
      configuration: { configured: false },
    }),
    GATEKEEPER_CONTEXT: vendor({
      displayName: "Context Library",
      url: "https://example.com/context",
    }),
    CONNECTOR_CONFIG_ACCOUNT_ID: "a".repeat(32),
    CONNECTOR_CONFIG_WORKER_PREFIX: "customer-gatekeeper-",
    CONNECTOR_CONFIG_API_TOKEN: "control-plane-token",
    PUBLIC_BASE_URL: "https://workshop.example",
    ...overrides,
  } as Cloudflare.Env;
}

function api(env: Cloudflare.Env, fetchImpl: typeof fetch = fetch): AdminApiImpl {
  return Reflect.construct(AdminApiImpl, [{}, "admin-user", env, fetchImpl]);
}

async function call<T>(target: object, methodName: string, args: unknown[] = []): Promise<T> {
  const method = Reflect.get(target, methodName);
  expect(method, `${methodName} must exist`).toBeTypeOf("function");
  return Reflect.apply(method, target, args) as Promise<T>;
}

describe("AdminApi connector configuration listing", () => {
  it("lists only kernel-owned connector inputs without secret readback", async () => {
    const compromisedConfiguration = {
      configured: false,
      inputs: [{ name: "TOKEN_ENCRYPTION_KEY", label: "Encryption key", secret: true }],
    };
    const result = await call<unknown[]>(api(environment({
      GATEKEEPER_GITHUB: vendor({
        displayName: "GitHub",
        url: "https://github.com",
        logo: { url: "https://example.com/github.svg" },
        configuration: compromisedConfiguration,
      } as unknown as VendorDescription),
    })), "listConnectorConfigurations");

    expect(result).toEqual([{
      id: "github",
      displayName: "GitHub",
      logo: { url: "https://example.com/github.svg" },
      configured: false,
      callbackUrl: "https://workshop.example/gatekeeper/github/oauth",
      setupGuideUrl: "https://github.com/Lumirator-Ltd/cloudflare-os/tree/main/packages/gatekeeper-github#readme",
      inputs: INPUTS,
      writeAvailable: true,
    }]);
    expect(JSON.stringify(result)).not.toContain("TOKEN_ENCRYPTION_KEY");
    expect(JSON.stringify(result)).not.toContain("control-plane-token");
    expect(JSON.stringify(result)).not.toContain("values");
  });

  it("lists the bound MCP portal with its plain URL input and no callback", async () => {
    const result = await call<unknown[]>(api(environment({
      GATEKEEPER_GITHUB: vendor({ displayName: "GitHub", url: "https://github.com" }),
      GATEKEEPER_MCP_PORTAL: vendor({
        displayName: "MCP Portal",
        url: "https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/",
        configuration: { configured: false },
      }),
    })), "listConnectorConfigurations");

    expect(result).toEqual([{
      id: "mcp_portal",
      displayName: "MCP Portal",
      configured: false,
      setupGuideUrl:
        "https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/",
      inputs: [{ name: "MCP_PORTAL_URL", label: "Portal URL", secret: false }],
      writeAvailable: true,
    }]);
  });

  it("uses immutable HubSpot inputs and a server-owned setup guide", async () => {
    const result = await call<unknown[]>(api(environment({
      GATEKEEPER_GITHUB: vendor({ displayName: "GitHub", url: "https://github.com" }),
      GATEKEEPER_HUBSPOT: vendor({
        displayName: "HubSpot",
        url: "https://www.hubspot.com",
        logo: { url: "https://example.com/hubspot.svg" },
        configuration: {
          configured: false,
          inputs: [{ name: "PRIVATE_APP_TOKEN", label: "Private app token", secret: true }],
          setupGuideUrl: "https://attacker.example/setup",
        },
      } as unknown as VendorDescription),
    })), "listConnectorConfigurations");

    expect(result).toEqual([{
      id: "hubspot",
      displayName: "HubSpot",
      logo: { url: "https://example.com/hubspot.svg" },
      configured: false,
      callbackUrl: "https://workshop.example/gatekeeper/hubspot/oauth",
      setupGuideUrl:
        "https://github.com/Lumirator-Ltd/cloudflare-os/tree/main/packages/gatekeeper-hubspot#readme",
      inputs: INPUTS,
      writeAvailable: true,
    }]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_APP_TOKEN");
    expect(JSON.stringify(result)).not.toContain("attacker.example");
  });

  it("logs redacted discovery warnings when describe fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const secretValue = "connector-secret-that-must-not-be-logged";

    const result = await call<unknown[]>(api(environment({
      GATEKEEPER_GITHUB: {
        async describe() { throw new Error(secretValue); },
      } as Service<GatekeeperVendor>,
    })), "listConnectorConfigurations");

    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).toContain("github");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secretValue);
  });

  it("omits an allowlisted connector that does not declare readiness metadata", async () => {
    const result = await call<unknown[]>(api(environment({
      GATEKEEPER_GITHUB: vendor({
        displayName: "GitHub",
        url: "https://github.com",
      }),
    })), "listConnectorConfigurations");

    expect(result).toEqual([]);
  });

  it.each([
    ["missing account", { CONNECTOR_CONFIG_ACCOUNT_ID: undefined }],
    ["malformed account", { CONNECTOR_CONFIG_ACCOUNT_ID: "A".repeat(32) }],
    ["missing prefix", { CONNECTOR_CONFIG_WORKER_PREFIX: undefined }],
    ["malformed prefix", { CONNECTOR_CONFIG_WORKER_PREFIX: "bad/prefix" }],
    ["missing token", { CONNECTOR_CONFIG_API_TOKEN: undefined }],
    ["malformed public URL", { PUBLIC_BASE_URL: "ftp://workshop.example" }],
  ])("reports writes unavailable for %s", async (_name, overrides) => {
    const [result] = await call<Array<{ writeAvailable: boolean }>>(
      api(environment(overrides)),
      "listConnectorConfigurations",
    );

    expect(result.writeAvailable).toBe(false);
  });
});

describe("AdminApi.configureConnector", () => {
  it("writes each declared secret to the expected Cloudflare endpoint", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ input, init });
      return new Response(null, { status: 200 });
    };

    await call(api(environment(), fetchImpl), "configureConnector", ["github", {
      CLIENT_ID: "client-id-value",
      CLIENT_SECRET: "client-secret-value",
    }]);

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(String(request.input)).toBe(
        `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}` +
        "/workers/scripts/customer-gatekeeper-github/secrets",
      );
      const headers = new Headers(request.init?.headers);
      expect(headers.get("authorization")).toBe("Bearer control-plane-token");
      expect(headers.get("content-type")).toBe("application/json");
      expect(request.init?.method).toBe("PUT");
    }
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      name: "CLIENT_ID",
      text: "client-id-value",
      type: "secret_text",
    });
    expect(JSON.parse(String(requests[1].init?.body))).toEqual({
      name: "CLIENT_SECRET",
      text: "client-secret-value",
      type: "secret_text",
    });
  });

  it("writes the MCP portal URL to the mcp-portal Worker", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ input, init });
      return new Response(null, { status: 200 });
    };

    await call(api(environment({
      GATEKEEPER_MCP_PORTAL: vendor({
        displayName: "MCP Portal",
        url: "https://example.com/mcp",
        configuration: { configured: false },
      }),
    }), fetchImpl), "configureConnector", ["mcp_portal", {
      MCP_PORTAL_URL: "https://PORTAL.Example:443/mcp",
    }]);

    expect(requests).toHaveLength(1);
    expect(String(requests[0].input)).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}` +
      "/workers/scripts/customer-gatekeeper-mcp-portal/secrets",
    );
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      name: "MCP_PORTAL_URL",
      text: "https://portal.example/mcp",
      type: "secret_text",
    });
  });

  it("rejects unbound connectors and bound connectors without configuration metadata", async () => {
    await expect(call(api(environment()), "configureConnector", ["missing", {}]))
      .rejects.toThrow(/not configurable/);
    await expect(call(api(environment()), "configureConnector", ["context", {}]))
      .rejects.toThrow(/not configurable/);
    await expect(call(api(environment({
      GATEKEEPER_GITHUB: vendor({ displayName: "GitHub", url: "https://github.com" }),
    })), "configureConnector", ["github", {
      CLIENT_ID: "id",
      CLIENT_SECRET: "secret",
    }])).rejects.toThrow(/not configurable/);
  });

  it("redacts connector discovery failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const secretValue = "describe-secret-that-must-not-be-exposed";
    const fetchImpl = vi.fn<typeof fetch>();

    const error = await call(
      api(environment({
        GATEKEEPER_GITHUB: {
          async describe() { throw new Error(secretValue); },
        } as Service<GatekeeperVendor>,
      }), fetchImpl),
      "configureConnector",
      ["github", { CLIENT_ID: "client-id-value", CLIENT_SECRET: "client-secret-value" }],
    ).catch(value => value);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Connector configuration could not be discovered.");
    expect(error.message).not.toContain(secretValue);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).toContain("github");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secretValue);
  });

  it("never writes a secret name advertised by a compromised connector", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const compromised = environment({
      GATEKEEPER_GITHUB: vendor({
        displayName: "GitHub",
        url: "https://github.com",
        configuration: {
          configured: false,
          inputs: [{ name: "TOKEN_ENCRYPTION_KEY", label: "Encryption key", secret: true }],
        },
      } as unknown as VendorDescription),
    });

    await expect(call(api(compromised, fetchImpl), "configureConnector", ["github", {
      TOKEN_ENCRYPTION_KEY: "do-not-write",
    }])).rejects.toThrow(/Unexpected connector input: TOKEN_ENCRYPTION_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires exactly every declared input key", async () => {
    const target = api(environment());
    await expect(call(target, "configureConnector", ["github", {
      CLIENT_ID: "id",
    }])).rejects.toThrow(/CLIENT_SECRET/);
    await expect(call(target, "configureConnector", ["github", {
      CLIENT_ID: "id",
      CLIENT_SECRET: "secret",
      EXTRA: "nope",
    }])).rejects.toThrow(/EXTRA/);
  });

  it.each([
    ["empty", ""],
    ["control character", "line\nbreak"],
    ["too long", "x".repeat(4097)],
  ])("rejects an %s input value", async (_name, invalidValue) => {
    await expect(call(api(environment()), "configureConnector", ["github", {
      CLIENT_ID: invalidValue,
      CLIENT_SECRET: "secret",
    }])).rejects.toThrow(/CLIENT_ID/);
  });

  it.each([
    ["HTTP URL", "http://portal.example/mcp"],
    ["relative URL", "/mcp"],
    ["malformed URL", "https://"],
    ["userinfo", "https://user:password@portal.example/mcp"],
    ["query", "https://portal.example/mcp?tenant=secret"],
    ["fragment", "https://portal.example/mcp#secret"],
    ["empty value", ""],
    ["control character", "https://portal.example/\u0000mcp"],
    ["overlong value", `https://portal.example/${"x".repeat(4097)}`],
  ])("rejects an MCP portal %s before fetching", async (_name, invalidUrl) => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(call(api(environment({
      GATEKEEPER_MCP_PORTAL: vendor({
        displayName: "MCP Portal",
        url: "https://example.com/mcp",
        configuration: { configured: false },
      }),
    }), fetchImpl), "configureConnector", ["mcp_portal", {
      MCP_PORTAL_URL: invalidUrl,
    }])).rejects.toThrow(/MCP_PORTAL_URL/);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails clearly when the control plane is unavailable", async () => {
    await expect(call(
      api(environment({ CONNECTOR_CONFIG_API_TOKEN: undefined })),
      "configureConnector",
      ["github", { CLIENT_ID: "id", CLIENT_SECRET: "secret" }],
    )).rejects.toThrow("Connector configuration writes are not available on this deployment.");
  });

  it("redacts non-success responses after a partial write", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      return calls === 1
        ? new Response(null, { status: 200 })
        : new Response("client-secret-value leaked by upstream", { status: 503 });
    };

    const error = await call(
      api(environment(), fetchImpl),
      "configureConnector",
      ["github", { CLIENT_ID: "client-id-value", CLIENT_SECRET: "client-secret-value" }],
    ).catch(value => value);

    expect(calls).toBe(2);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("503");
    expect(error.message).toContain("partially updated");
    expect(error.message).toContain("retry with the same values");
    expect(error.message).not.toContain("client-id-value");
    expect(error.message).not.toContain("client-secret-value");
    expect(error.message).not.toContain("leaked by upstream");
    expect(error.message).not.toContain("control-plane-token");
  });

  it("warns about a possible partial update after a later fetch failure", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      if (calls === 1) return new Response(null, { status: 200 });
      throw new Error("client-secret-value leaked by transport");
    };

    const error = await call(
      api(environment(), fetchImpl),
      "configureConnector",
      ["github", { CLIENT_ID: "client-id-value", CLIENT_SECRET: "client-secret-value" }],
    ).catch(value => value);

    expect(error.message).toContain("partially updated");
    expect(error.message).toContain("retry with the same values");
    expect(error.message).not.toContain("client-secret-value");
  });

  it("warns about a possible partial update after the first fetch failure", async () => {
    const error = await call(
      api(environment(), failingFetch),
      "configureConnector",
      ["github", { CLIENT_ID: "client-id-value", CLIENT_SECRET: "client-secret-value" }],
    ).catch(value => value);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("credentials may have been partially updated");
    expect(error.message).toContain("retry with the same values");
    expect(error.message).not.toContain("client-id-value");
    expect(error.message).not.toContain("client-secret-value");
    expect(error.message).not.toContain("control-plane-token");
  });
});
