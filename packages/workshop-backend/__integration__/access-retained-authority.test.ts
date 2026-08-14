import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { AdminApi, AuthenticatedApi, PublicApi } from "@gadgets/workshop-shared/api";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const ACCESS_ISSUER = "https://retained-authority.cloudflareaccess.test";
const ACCESS_AUDIENCE = "retained-authority-audience";
const ACCESS_KEY_ID = "retained-authority-key";

let privateKey: CryptoKey;
let publicJwk: JsonWebKey;

async function accessToken(email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    iss: ACCESS_ISSUER,
    aud: ACCESS_AUDIENCE,
    sub: `access-${crypto.randomUUID()}`,
    email,
    iat: now - 10,
    nbf: now - 15,
    exp: now + 120,
  }).setProtectedHeader({ alg: "RS256", kid: ACCESS_KEY_ID, typ: "JWT" }).sign(privateKey);
}

async function connectWithAccess(email: string): Promise<RpcStub<PublicApi>> {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: {
      Upgrade: "websocket",
      Origin: "https://workshop.invalid",
      "cf-access-jwt-assertion": await accessToken(email),
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
  vi.restoreAllMocks();
});

describe("retained Cloudflare Access authority", () => {
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

    using publicApi = await connectWithAccess(email);
    using api = await publicApi.authenticateFromCfAccess() as RpcStub<AuthenticatedApi>;
    await expect(api.amIAdmin()).resolves.toBe(true);
    const retainedAdmin = await api.getAdminApi();
    if (!retainedAdmin) throw new Error("Access admin did not receive AdminApi");
    using admin = retainedAdmin as RpcStub<AdminApi>;
    await expect(admin.getSettings()).resolves.toMatchObject({ signupsEnabled: true });

    const broken = Promise.withResolvers<void>();
    api.onRpcBroken(() => broken.resolve());

    const registry = exports.IdentityRegistry.getByName("");
    const subject = `subject-${crypto.randomUUID()}`;
    await registry.resolveClerkIdentity(subject, email, false);
    await registry.resolveClerkIdentity(
      subject, `access-moved-${crypto.randomUUID()}@example.com`, false,
    );

    await expect(Promise.race([
      broken.promise.then(() => "broken"),
      new Promise(resolve => setTimeout(() => resolve("timeout"), 5_000)),
    ])).resolves.toBe("broken");
    await expect(api.whoami()).rejects.toThrow();
    await expect(admin.getSettings()).rejects.toThrow();
  });
});
