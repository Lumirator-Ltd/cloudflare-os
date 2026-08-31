import {
  abortAllDurableObjects,
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { newHttpBatchRpcSession, newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { AdminApi, AuthenticatedApi, PublicApi } from "@gadgets/workshop-shared/api";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { IdentityRegistry } from "../src/identity-registry.js";
import worker, { PublicApiImpl } from "../src/server.js";

const ACCESS_ISSUER = "https://retained-authority.cloudflareaccess.test";
const ACCESS_AUDIENCE = "retained-authority-audience";
const ACCESS_KEY_ID = "retained-authority-key";

let privateKey: CryptoKey;
let publicJwk: JsonWebKey;

async function accessToken(
    email: string,
    overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    iss: ACCESS_ISSUER,
    aud: ACCESS_AUDIENCE,
    sub: `access-${crypto.randomUUID()}`,
    email,
    iat: now - 10,
    nbf: now - 15,
    exp: now + 120,
    ...overrides,
  }).setProtectedHeader({ alg: "RS256", kid: ACCESS_KEY_ID, typ: "JWT" }).sign(privateKey);
}

async function connectWithAccess(
    email: string,
    overrides: Record<string, unknown> = {},
): Promise<RpcStub<PublicApi>> {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: {
      Upgrade: "websocket",
      Origin: "https://workshop.invalid",
      "cf-access-jwt-assertion": await accessToken(email, overrides),
    },
  }));
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`Expected Access WebSocket RPC response, got ${response.status}.`);
  }
  response.webSocket.accept();
  return newWebSocketRpcSession<PublicApi>(response.webSocket);
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = {
    ...await exportJWK(pair.publicKey),
    kid: ACCESS_KEY_ID,
    alg: "RS256",
    use: "sig",
  };
});

afterEach(async () => {
  const mutableEnv = env as Cloudflare.Env;
  delete mutableEnv.CF_ACCESS_AUD;
  delete mutableEnv.CF_ACCESS_ISS;
  delete mutableEnv.ADMINS;
  await exports.AdminSettings.getByName("").updateAdminConfig({ signupsEnabled: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("retained Cloudflare Access authority", () => {
  it.each([
    ["missing subject", { sub: undefined }],
    ["blank subject", { sub: "  " }],
    ["missing email", { email: undefined }],
    ["blank email", { email: "\t" }],
    ["missing expiry", { exp: undefined }],
    ["invalid expiry", { exp: "later" }],
    ["expiry outside JavaScript Date range", { exp: 8_640_000_000_001 }],
    ["wrong issuer", { iss: "https://attacker.cloudflareaccess.test" }],
    ["wrong audience", { aud: "attacker-audience" }],
    ["expired assertion", { exp: Math.floor(Date.now() / 1_000) - 1 }],
  ])("rejects an Access WebSocket handshake with %s", async (_name, overrides) => {
    const mutableEnv = env as Cloudflare.Env;
    mutableEnv.CF_ACCESS_AUD = ACCESS_AUDIENCE;
    mutableEnv.CF_ACCESS_ISS = ACCESS_ISSUER;

    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const request = new Request(input);
      if (request.url === `${ACCESS_ISSUER}/cdn-cgi/access/certs`) {
        return Response.json({ keys: [publicJwk] });
      }
      throw new Error(`Unexpected network request: ${request.url}`);
    });

    const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
      headers: {
        Upgrade: "websocket",
        Origin: "https://workshop.invalid",
        "cf-access-jwt-assertion": await accessToken("person@example.com", overrides),
      },
    }));

    expect(response.status).toBe(403);
    expect(response.webSocket).toBeNull();
  });

  it("drains Access HTTP batch cleanup before releasing its registry subscriber", async () => {
    const email = `access-batch-${crypto.randomUUID()}@example.com`;
    const mutableEnv = env as Cloudflare.Env;
    mutableEnv.CF_ACCESS_AUD = ACCESS_AUDIENCE;
    mutableEnv.CF_ACCESS_ISS = ACCESS_ISSUER;
    await exports.AdminSettings.getByName("").updateAdminConfig({ signupsEnabled: true });

    // Keep unrelated one-time blueprint installation work out of the execution context under test.
    const warmupContext = createExecutionContext();
    await worker.fetch(new Request("https://workshop.invalid/api", {
      headers: { Origin: "https://workshop.invalid" },
    }), mutableEnv, warmupContext);
    await waitOnExecutionContext(warmupContext);

    const register = vi.spyOn(IdentityRegistry.prototype, "registerIdentitySession");
    const dispose = vi.spyOn(PublicApiImpl.prototype, Symbol.dispose);
    const context = createExecutionContext();
    let batchResponse: Response | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url === `${ACCESS_ISSUER}/cdn-cgi/access/certs`) {
        return Response.json({ keys: [publicJwk] });
      }
      if (request.url === "https://workshop.invalid/api") {
        batchResponse = await worker.fetch(request, mutableEnv, context);
        return batchResponse;
      }
      throw new Error(`Unexpected network request: ${request.url}`);
    });

    using publicApi = newHttpBatchRpcSession<PublicApi>(new Request(
      "https://workshop.invalid/api",
      {
        headers: {
          Origin: "https://workshop.invalid",
          "cf-access-jwt-assertion": await accessToken(email),
        },
      },
    ));
    await expect(publicApi.authenticateFromCfAccess().whoami())
      .resolves.toMatchObject({ id: expect.any(String) });
    expect(batchResponse?.status).toBe(200);
    expect(register).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();

    await waitOnExecutionContext(context);
    await runInDurableObject(exports.IdentityRegistry.getByName(""), instance => {
      const inspected = instance as unknown as {
        identitySessions: Map<string, Map<string, unknown>>;
      };
      expect(inspected.identitySessions.size).toBe(0);
    });
  });

  it("breaks a real WebSocket graph and retained descendants at the signed JWT expiry", async () => {
    const email = `access-expiry-admin-${crypto.randomUUID()}@example.com`;
    const mutableEnv = env as Cloudflare.Env;
    mutableEnv.CF_ACCESS_AUD = ACCESS_AUDIENCE;
    mutableEnv.CF_ACCESS_ISS = ACCESS_ISSUER;
    mutableEnv.ADMINS = [email];
    await exports.AdminSettings.getByName("").updateAdminConfig({ signupsEnabled: true });

    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const request = new Request(input);
      if (request.url === `${ACCESS_ISSUER}/cdn-cgi/access/certs`) {
        return Response.json({ keys: [publicJwk] });
      }
      throw new Error(`Unexpected network request: ${request.url}`);
    });

    while (Date.now() % 1_000 > 100) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const expiry = Math.floor(Date.now() / 1_000) + 1;
    using publicApi = await connectWithAccess(email, { exp: expiry });
    using api = await publicApi.authenticateFromCfAccess() as RpcStub<AuthenticatedApi>;
    const retainedAdmin = await api.getAdminApi();
    if (!retainedAdmin) throw new Error("Access admin did not receive AdminApi");
    using admin = retainedAdmin as RpcStub<AdminApi>;
    await expect(admin.getSettings()).resolves.toMatchObject({ signupsEnabled: true });

    const broken = Promise.withResolvers<void>();
    api.onRpcBroken(() => broken.resolve());
    await expect(Promise.race([
      broken.promise.then(() => "broken"),
      new Promise(resolve => setTimeout(() => resolve("timeout"), 1_500)),
    ])).resolves.toBe("broken");
    await expect(api.whoami()).rejects.toThrow();
    await expect(admin.getSettings()).rejects.toThrow();
  });

  it("watchdog breaks retained descendants after registry restart loses the live subscriber",
      async () => {
    const email = `access-restart-admin-${crypto.randomUUID()}@example.com`;
    const accessSubject = `access-restart-${crypto.randomUUID()}`;
    const mutableEnv = env as Cloudflare.Env;
    mutableEnv.CF_ACCESS_AUD = ACCESS_AUDIENCE;
    mutableEnv.CF_ACCESS_ISS = ACCESS_ISSUER;
    mutableEnv.ADMINS = [email];
    await exports.AdminSettings.getByName("").updateAdminConfig({ signupsEnabled: true });

    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const request = new Request(input);
      if (request.url === `${ACCESS_ISSUER}/cdn-cgi/access/certs`) {
        return Response.json({ keys: [publicJwk] });
      }
      throw new Error(`Unexpected network request: ${request.url}`);
    });

    using publicApi = await connectWithAccess(email, {
      sub: accessSubject,
      exp: Math.floor(Date.now() / 1_000) + 120,
    });
    using api = await publicApi.authenticateFromCfAccess() as RpcStub<AuthenticatedApi>;
    const retainedAdmin = await api.getAdminApi();
    if (!retainedAdmin) throw new Error("Access admin did not receive AdminApi");
    using admin = retainedAdmin as RpcStub<AdminApi>;
    await expect(admin.getSettings()).resolves.toBeDefined();
    const broken = Promise.withResolvers<void>();
    api.onRpcBroken(() => broken.resolve());

    await abortAllDurableObjects();
    await exports.IdentityRegistry.getByName("").resolveAccessIdentity(
      ACCESS_ISSUER,
      ACCESS_AUDIENCE,
      accessSubject,
      `access-restart-moved-${crypto.randomUUID()}@example.com`,
      false,
    );

    await expect(Promise.race([
      broken.promise.then(() => "broken"),
      new Promise(resolve => setTimeout(() => resolve("timeout"), 30_000)),
    ])).resolves.toBe("broken");
    await expect(api.whoami()).rejects.toThrow();
    await expect(admin.getSettings()).rejects.toThrow();
  }, 35_000);

  it("eagerly breaks an existing WebSocket capability graph after an identity version move",
      async () => {
    const email = `access-admin-${crypto.randomUUID()}@example.com`;
    const mutableEnv = env as Cloudflare.Env;
    mutableEnv.CF_ACCESS_AUD = ACCESS_AUDIENCE;
    mutableEnv.CF_ACCESS_ISS = ACCESS_ISSUER;
    mutableEnv.ADMINS = [email];
    await exports.AdminSettings.getByName("").updateAdminConfig({ signupsEnabled: true });

    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const request = new Request(input);
      if (request.url === `${ACCESS_ISSUER}/cdn-cgi/access/certs`) {
        return Response.json({ keys: [publicJwk] });
      }
      throw new Error(`Unexpected network request: ${request.url}`);
    });

    const accessSubject = `access-${crypto.randomUUID()}`;
    using publicApi = await connectWithAccess(email, { sub: accessSubject });
    using api = await publicApi.authenticateFromCfAccess() as RpcStub<AuthenticatedApi>;
    await expect(api.amIAdmin()).resolves.toBe(true);
    const retainedAdmin = await api.getAdminApi();
    if (!retainedAdmin) throw new Error("Access admin did not receive AdminApi");
    using admin = retainedAdmin as RpcStub<AdminApi>;
    await expect(admin.getSettings()).resolves.toMatchObject({ signupsEnabled: true });

    const broken = Promise.withResolvers<void>();
    api.onRpcBroken(() => broken.resolve());

    const registry = exports.IdentityRegistry.getByName("");
    await registry.resolveAccessIdentity(
      ACCESS_ISSUER,
      ACCESS_AUDIENCE,
      accessSubject,
      `access-moved-${crypto.randomUUID()}@example.com`,
      false,
    );

    await expect(Promise.race([
      broken.promise.then(() => "broken"),
      new Promise(resolve => setTimeout(() => resolve("timeout"), 5_000)),
    ])).resolves.toBe("broken");
    await expect(api.whoami()).rejects.toThrow();
    await expect(admin.getSettings()).rejects.toThrow();
  });
});
