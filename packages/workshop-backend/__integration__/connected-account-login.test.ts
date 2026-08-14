import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import type { GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import { describe, expect, it, vi } from "vitest";
import type { UserDurableObject } from "../src/user.js";

type ConnectedAccountRecord = Parameters<UserDurableObject["putConnectedAccount"]>[0];

class TestAccount {
  revokeCalls = 0;

  constructor(
    private label: string,
    private revokeError?: Error,
  ) {}

  async describe() {
    return {
      displayName: this.label,
      uniqueName: "person@example.com",
    };
  }

  async revoke(): Promise<void> {
    this.revokeCalls++;
    if (this.revokeError) throw this.revokeError;
  }
}

function asAccount(account: TestAccount): Fetcher<GatekeeperUser> {
  return account as unknown as Fetcher<GatekeeperUser>;
}

async function withFakeAccountStorage<T>(
  callback: (user: UserDurableObject, records: Map<number, ConnectedAccountRecord>) => Promise<T>,
): Promise<T> {
  const stub = exports.UserDurableObject.getByName(`login-link-${crypto.randomUUID()}`);
  return await runInDurableObject(stub, async (user: UserDurableObject) => {
    const records = new Map<number, ConnectedAccountRecord>();
    let nextAccountId = 0;
    Object.assign(user, {
      storage: {
        transaction<R>(operation: () => R): R {
          return operation();
        },
        connectedAccounts: {
          get(id: number) {
            return records.get(id);
          },
          put(record: ConnectedAccountRecord) {
            records.set(record.id, record);
          },
          delete(id: number) {
            return records.delete(id);
          },
        },
        nextAccountId: {
          get() {
            return nextAccountId;
          },
          put(value: number) {
            nextAccountId = value;
          },
        },
        cloudflareBilling: {
          put() {},
        },
      },
    });
    return await callback(user, records);
  });
}

describe("connected accounts linked during login", () => {
  it("restores a pre-existing account without revoking its capability", async () => {
    const prior = new TestAccount("prior");
    const fresh = new TestAccount("fresh");

    const storedLabel = await withFakeAccountStorage(async user => {
      const initialLink = await user.linkConnectedAccountFromLogin(
        asAccount(prior), "cloudflare");
      user.commitConnectedAccountLogin(initialLink);
      const staleLink = await user.linkConnectedAccountFromLogin(
        asAccount(fresh), "cloudflare");

      user.rollbackConnectedAccountLogin(staleLink);

      return (await user.getCloudflareGatekeeperAccount())?.describe();
    });

    expect(await storedLabel).toMatchObject({ displayName: "prior" });
    expect(prior.revokeCalls).toBe(0);
    await vi.waitFor(() => expect(fresh.revokeCalls).toBe(1));
  });

  it("removes a new local account before best-effort revocation rejects", async () => {
    const fresh = new TestAccount("fresh", new Error("revoke rejected"));

    const localAccountAfterRollback = await withFakeAccountStorage(async (user, records) => {
      const staleLink = await user.linkConnectedAccountFromLogin(
        asAccount(fresh), "cloudflare");

      expect(user.rollbackConnectedAccountLogin(staleLink)).toBeUndefined();
      return records.get(staleLink.accountId);
    });

    expect(localAccountAfterRollback).toBeUndefined();
    await vi.waitFor(() => expect(fresh.revokeCalls).toBe(1));
  });

  it("does not delete or revoke a concurrent replacement at the same account ID", async () => {
    const fresh = new TestAccount("fresh");
    const newer = new TestAccount("newer");

    const storedLabel = await withFakeAccountStorage(async user => {
      const staleLink = await user.linkConnectedAccountFromLogin(
        asAccount(fresh), "cloudflare");
      await user.putConnectedAccount({
        id: staleLink.accountId,
        account: asAccount(newer),
        description: await newer.describe(),
        vendorId: "cloudflare",
      });

      user.rollbackConnectedAccountLogin(staleLink);

      return (await user.getCloudflareGatekeeperAccount())?.describe();
    });

    expect(await storedLabel).toMatchObject({ displayName: "newer" });
    expect(fresh.revokeCalls).toBe(0);
    expect(newer.revokeCalls).toBe(0);
  });

  it("revokes the exact newly linked account after removing it", async () => {
    const fresh = new TestAccount("fresh");

    const localAccountAfterRollback = await withFakeAccountStorage(async (user, records) => {
      const staleLink = await user.linkConnectedAccountFromLogin(
        asAccount(fresh), "cloudflare");

      user.rollbackConnectedAccountLogin(staleLink);

      return records.get(staleLink.accountId);
    });

    expect(localAccountAfterRollback).toBeUndefined();
    await vi.waitFor(() => expect(fresh.revokeCalls).toBe(1));
  });
});
