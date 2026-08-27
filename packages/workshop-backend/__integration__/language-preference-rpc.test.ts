import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { PublicApi } from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";

const PASSWORD_HASH = new Uint8Array([7, 8, 9]);
const USER_DO_ABORT_REASON = "user-DO reset injected by test";

function username(prefix: string): string {
  return prefix + crypto.randomUUID().replaceAll("-", "");
}

async function connect(): Promise<RpcStub<PublicApi>> {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: { Upgrade: "websocket" },
  }));
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

async function createAccount(
    publicApi: RpcStub<PublicApi>, prefix: string): Promise<{username: string; token: string}> {
  const name = username(prefix);
  const token = await publicApi.createAccount(name, name, PASSWORD_HASH);
  if (token === null) throw new Error(`Failed to create ${name}.`);
  return { username: name, token };
}

async function rejection(value: PromiseLike<unknown>): Promise<Error> {
  try {
    await value;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new TypeError("Expected an Error rejection.", { cause: error });
  }
  throw new Error("Expected rejection.");
}

describe("authenticated language preferences", () => {
  it("defaults each user to automatic language selection", async () => {
    using publicApi = await connect();
    const firstAccount = await createAccount(publicApi, "languagedefaulta");
    const secondAccount = await createAccount(publicApi, "languagedefaultb");
    using first = await publicApi.authenticate(firstAccount.token);
    using second = await publicApi.authenticate(secondAccount.token);

    await expect(first.getLanguagePreference()).resolves.toBe("auto");
    await expect(second.getLanguagePreference()).resolves.toBe("auto");
  });

  it("isolates preferences and persists them across authenticated sessions and a user DO restart", async () => {
    using publicApi = await connect();
    const firstAccount = await createAccount(publicApi, "languagepersista");
    const secondAccount = await createAccount(publicApi, "languagepersistb");

    {
      using firstSession = await publicApi.authenticate(firstAccount.token);
      await firstSession.setLanguagePreference("ja");
    }

    using freshFirstSession = await publicApi.authenticate(firstAccount.token);
    using secondSession = await publicApi.authenticate(secondAccount.token);
    await expect(freshFirstSession.getLanguagePreference()).resolves.toBe("ja");
    await expect(secondSession.getLanguagePreference()).resolves.toBe("auto");

    const userStub = exports.UserDurableObject.get(
      exports.UserDurableObject.idFromName(firstAccount.username),
    );
    await rejection(runInDurableObject(userStub, (_instance, state) => {
      state.abort(USER_DO_ABORT_REASON);
    }));

    await expect(freshFirstSession.getLanguagePreference()).resolves.toBe("ja");
  });

  it("rejects unknown preferences without changing the stored preference", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "languageinvalid");
    using authenticated = await publicApi.authenticate(account.token);
    await authenticated.setLanguagePreference("en");

    const userStub = exports.UserDurableObject.get(
      exports.UserDurableObject.idFromName(account.username),
    );
    const errorMessage = await runInDurableObject(userStub, async (instance) => {
      try {
        await Reflect.apply(instance.setLanguagePreference, instance, ["fr"]);
      } catch (error) {
        if (error instanceof Error) return error.message;
        throw error;
      }
      return null;
    });
    expect(errorMessage).toBe("Unsupported language preference.");
    await expect(authenticated.getLanguagePreference()).resolves.toBe("en");
  });

  it("defensively reads unknown stored values as automatic language selection", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "languagecorrupt");
    using authenticated = await publicApi.authenticate(account.token);
    const userStub = exports.UserDurableObject.get(
      exports.UserDurableObject.idFromName(account.username),
    );

    await runInDurableObject(userStub, (_instance, state) => {
      state.storage.kv.put("languagePreference", "fr");
    });

    await expect(authenticated.getLanguagePreference()).resolves.toBe("auto");
  });
});
