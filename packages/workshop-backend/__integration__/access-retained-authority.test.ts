import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { AuthenticatedApi, PublicApi } from "@gadgets/workshop-shared/api";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const ACCESS_ISSUER = "https://retained-authority.cloudflareaccess.test";
const ACCESS_AUDIENCE = "retained-authority-audience";
const ACCESS_KEY_ID = "retained-authority-key";

let privateKey: CryptoKey;
let publicJwk: JsonWebKey;

async function accessToken(email: string, expiry: number): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    iss: ACCESS_ISSUER,
    aud: ACCESS_AUDIENCE,
    sub: `access-${crypto.randomUUID()}`,
    email,
    iat: now - 10,
    nbf: now - 15,
    exp: expiry,
  }).setProtectedHeader({ alg: "RS256", kid: ACCESS_KEY_ID, typ: "JWT" }).sign(privateKey);
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

afterEach(() => {
  const mutableEnv = env as Cloudflare.Env;
  delete mutableEnv.CF_ACCESS_AUD;
  delete mutableEnv.CF_ACCESS_ISS;
  vi.restoreAllMocks();
});

describe("retained Cloudflare Access authority", () => {
  it("does not locally abort an established capability at JWT expiry", async () => {
    const email = `access-retained-${crypto.randomUUID()}@example.com`;
    const mutableEnv = env as Cloudflare.Env;
    mutableEnv.CF_ACCESS_AUD = ACCESS_AUDIENCE;
    mutableEnv.CF_ACCESS_ISS = ACCESS_ISSUER;
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
    const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
      headers: {
        Upgrade: "websocket",
        Origin: "https://workshop.invalid",
        "cf-access-jwt-assertion": await accessToken(email, expiry),
      },
    }));
    expect(response.status).toBe(101);
    if (!response.webSocket) throw new Error("Access WebSocket response had no socket.");
    response.webSocket.accept();

    using publicApi = newWebSocketRpcSession<PublicApi>(response.webSocket);
    using api = await publicApi.authenticateFromCfAccess() as RpcStub<AuthenticatedApi>;
    await expect(api.whoami()).resolves.toMatchObject({ id: email });

    await new Promise(resolve => setTimeout(resolve, 1_200));

    await expect(api.whoami()).resolves.toMatchObject({ id: email });
  }, 5_000);
});
