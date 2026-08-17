import { exports } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { AdminApi, AuthenticatedApi, PublicApi } from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";

const PASSWORD_HASH = new Uint8Array([4, 5, 6]);

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

async function account(
  publicApi: RpcStub<PublicApi>,
  username: string,
): Promise<RpcStub<AuthenticatedApi>> {
  const token = await publicApi.createAccount(username, username, PASSWORD_HASH);
  if (!token) throw new Error(`Failed to create ${username}.`);
  return publicApi.authenticate(token);
}

async function rejection(value: PromiseLike<unknown>): Promise<Error> {
  try {
    await value;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new TypeError("Expected an Error rejection.", { cause: error });
  }
  throw new Error("Expected RPC rejection.");
}

describe("AdminApi authorization across the server RPC boundary", () => {
  it("mints the capability only for admins and rejects non-admin promise pipelining", async () => {
    using publicApi = await connect();
    using nonAdmin = await account(
      publicApi,
      `rpcuser${crypto.randomUUID().replaceAll("-", "")}`,
    );
    using admin = await account(publicApi, "rpcadmin");

    await expect(nonAdmin.getAdminApi()).resolves.toBeNull();

    const deniedPipeline = nonAdmin.getAdminApi() as unknown as RpcStub<AdminApi>;
    const deniedError = await rejection(deniedPipeline.configureConnector("github", {
      CLIENT_ID: "id",
      CLIENT_SECRET: "secret",
    }));
    expect(deniedError.message).toBe("'configureConnector' is not a function.");

    using adminApi = await admin.getAdminApi();
    expect(adminApi).not.toBeNull();
    await expect(adminApi!.configureConnector("github", {
      CLIENT_ID: "id",
      CLIENT_SECRET: "secret",
    })).rejects.toThrow(
      "Connector configuration writes are not available on this deployment.",
    );
  });
});
