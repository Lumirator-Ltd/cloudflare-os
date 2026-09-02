import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { AuthenticatedApi, AiModelConfig, PublicApi } from "@gadgets/workshop-shared/api";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import serverSource from "../src/server.ts?raw";

const ACCESS_ISSUER = "https://legacy-recovery.cloudflareaccess.test";
const ACCESS_AUDIENCE = "legacy-recovery-audience";
const ACCESS_KEY_ID = "legacy-recovery-key";
const PASSWORD_HASH = new Uint8Array([1, 2, 3]);

let privateKey: CryptoKey;
let publicJwk: JsonWebKey;

function uniqueEmail(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}@example.com`;
}

async function accessToken(email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    iss: ACCESS_ISSUER,
    aud: ACCESS_AUDIENCE,
    sub: `access-${crypto.randomUUID()}`,
    email,
    iat: now - 10,
    nbf: now - 15,
    exp: now + 300,
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

  expect(response.status).toBe(101);
  if (!response.webSocket) throw new Error("Access WebSocket response had no socket.");
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

afterEach(() => {
  const mutableEnv = env as Cloudflare.Env;
  delete mutableEnv.CF_ACCESS_AUD;
  delete mutableEnv.CF_ACCESS_ISS;
  vi.restoreAllMocks();
});

describe("legacy email-keyed account recovery", () => {
  it("recovers owner state, model routing, sharing, and canonical workspace ownership", async () => {
    const ownerEmail = uniqueEmail("legacy-owner");
    const recipientEmail = uniqueEmail("legacy-recipient");
    const ownerDisplayName = "Customized Legacy Owner";
    const recipientDisplayName = "Legacy Recipient";
    const legacyTitle = "Persisted Legacy Workspace";
    const editedTitle = "Recovered Legacy Workspace";
    const modelId = `legacy-model-${crypto.randomUUID()}`;
    const modelProfile = { type: "agent" as const, id: modelId, name: "Legacy Custom Model" };
    const modelConfig = {
      provider: "openai",
      model: "legacy-gpt-test",
      apiToken: "legacy-integration-token",
      apiUrl: "https://model.invalid/v1",
    } satisfies AiModelConfig;

    const ownerStub = exports.UserDurableObject.getByName(ownerEmail);
    const ownerId = ownerStub.id.toString();
    expect(ownerId).not.toBe(ownerEmail);
    expect(await ownerStub.createAccount(ownerEmail, "Original Owner", PASSWORD_HASH)).not.toBeNull();
    await ownerStub.setOwnDisplayName(ownerDisplayName);
    await ownerStub.addModel(modelProfile, modelConfig);
    await ownerStub.setPreferredModel(modelId);
    await ownerStub.setQuickModel(modelId);

    const legacyWorkspaceStub = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.newUniqueId(),
    );
    const legacyWorkspaceId = legacyWorkspaceStub.id.toString();
    await ownerStub.newGadget(legacyWorkspaceId, legacyTitle);
    await ownerStub.setGadgetLastActive(legacyWorkspaceId, new Date(), undefined);
    using seededWorkspace = await legacyWorkspaceStub.open(
      ownerId,
      ownerEmail,
      () => undefined,
    );
    await seededWorkspace.setTitle(legacyTitle);

    const recipientStub = exports.UserDurableObject.getByName(recipientEmail);
    expect(await recipientStub.createAccount(
      recipientEmail,
      recipientDisplayName,
      PASSWORD_HASH,
    )).not.toBeNull();

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

    using ownerPublicApi = await connectWithAccess(ownerEmail);
    using ownerApi = await ownerPublicApi.authenticateFromCfAccess() as RpcStub<AuthenticatedApi>;

    expect(await ownerApi.whoami()).toEqual({
      type: "user",
      id: ownerEmail,
      name: ownerDisplayName,
    });
    expect(await ownerApi.listModels()).toContainEqual(modelProfile);
    expect(await ownerApi.getPreferredModel()).toBe(modelId);
    expect(await ownerApi.getQuickModel()).toBe(modelId);
    expect(await ownerApi.listGadgets()).toEqual([
      expect.objectContaining({ id: legacyWorkspaceId, title: legacyTitle }),
    ]);

    using recoveredWorkspace = await ownerApi.openGadget(legacyWorkspaceId);
    expect(await recoveredWorkspace.getMetadata()).toMatchObject({
      id: legacyWorkspaceId,
      title: legacyTitle,
      role: "build",
    });
    await recoveredWorkspace.setTitle(editedTitle);
    expect(await recoveredWorkspace.getMetadata()).toMatchObject({ title: editedTitle });

    const reconstructedOwner = exports.UserDurableObject.get(
      exports.UserDurableObject.idFromString(ownerId),
    );
    expect(reconstructedOwner.id.toString()).toBe(ownerId);
    expect(await reconstructedOwner.getChatContext(modelId)).toEqual({
      profile: { type: "user", id: ownerEmail, name: ownerDisplayName },
      aiModel: { profile: modelProfile, config: modelConfig },
      quickModel: modelConfig,
    });

    expect(await recoveredWorkspace.addCollaborator(recipientEmail, "build"))
      .toMatchObject({
        profile: { type: "user", id: recipientEmail, name: recipientDisplayName },
        role: "build",
      });

    using recipientPublicApi = await connectWithAccess(recipientEmail);
    using recipientApi = await recipientPublicApi.authenticateFromCfAccess() as
      RpcStub<AuthenticatedApi>;
    using sharedWorkspace = await recipientApi.openGadget(legacyWorkspaceId);
    expect(await sharedWorkspace.getMetadata()).toMatchObject({
      id: legacyWorkspaceId,
      title: editedTitle,
      owner: { type: "user", id: ownerEmail, name: ownerDisplayName },
      role: "build",
    });

    using newWorkspace = await ownerApi.newGadget();
    const newWorkspaceMetadata = await newWorkspace.getMetadata();
    const newWorkspaceStub = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.idFromString(newWorkspaceMetadata.id),
    );
    await runInDurableObject(newWorkspaceStub, instance => {
      const inspected = instance as unknown as {
        impl: {
          ownerId?: string;
          storage: { ownerId: { get(): string | undefined } };
        };
      };
      expect(inspected.impl.ownerId).toBe(ownerId);
      expect(inspected.impl.storage.ownerId.get()).toBe(ownerId);
    });

    expect((await ownerApi.whoami()).id).toBe(ownerEmail);

    const accessMethodStart = serverSource.indexOf("async authenticateFromCfAccess()");
    const accessMethodEnd = serverSource.indexOf("\n  async login(", accessMethodStart);
    const accessMethodSource = serverSource.slice(accessMethodStart, accessMethodEnd);
    expect(accessMethodStart).toBeGreaterThan(-1);
    expect(accessMethodEnd).toBeGreaterThan(accessMethodStart);
    expect(accessMethodSource).toContain("this.users.idFromName(email)");
    const retiredRegistryClass = ["Identity", "Registry"].join("");
    const retiredEmailResolutionMethod = ["resolve", "Email", "Identity"].join("");
    expect(accessMethodSource).not.toContain(retiredRegistryClass);
    expect(accessMethodSource).not.toContain(retiredEmailResolutionMethod);
  });
});
