import { describe, expect, it, vi } from "vitest";
import { UserDurableObject } from "../src/user";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("connected account identity deduplication", () => {
  it("returns before asynchronously revoking a duplicate account capability", async () => {
    const revocation = deferred<void>();
    const revoke = vi.fn(async () => await revocation.promise);
    const existing = {
      id: 0,
      vendorId: "x",
      account: { revoke: vi.fn() },
      description: { uniqueName: "x:2244994945" },
    };
    const duplicate = {
      id: 1,
      vendorId: "x",
      account: { revoke },
      description: { uniqueName: "x:2244994945" },
    };
    const put = vi.fn();
    const background: Promise<unknown>[] = [];
    const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
    Object.assign(user, {
      ctx: { waitUntil: (promise: Promise<unknown>) => background.push(promise) },
      storage: {
        nextAccountId: { get: () => 2 },
        connectedAccounts: {
          get: (id: number) => id === 0 ? existing : undefined,
          put,
        },
      },
    });
    let completed = false;

    const completion = user.putConnectedAccount(duplicate as never).then(() => {
      completed = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(completed).toBe(true);
    expect(background).toHaveLength(1);
    expect(put).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledOnce();

    revocation.resolve();
    await completion;
    await Promise.all(background);
  });
});
