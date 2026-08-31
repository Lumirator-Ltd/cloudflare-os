import { RpcStub } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { ActionDescription, ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import {
  XActionStore,
  queueXAction,
  type XActionRecord,
  type XWriteOperation,
  type XWriteResult,
} from "../src/x-actions";

function storage(initial: Array<[string, unknown]> = []) {
  const data = new Map<string, unknown>(initial);
  const kv = {
    delete(key: string) { return data.delete(key); },
    get<T>(key: string) { return data.get(key) as T | undefined; },
    put<T>(key: string, value: T) { data.set(key, structuredClone(value)); },
  };
  return { data, kv };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const OPERATION: XWriteOperation = {
  type: "createPost",
  text: "Draft announcement",
};

describe("X action store", () => {
  it("stages before submission and moves only that record to pending", () => {
    const { kv } = storage();
    const store = new XActionStore(kv);

    const id = store.stage(OPERATION, 7);

    expect(id).toBe(0);
    expect(store.get(id)).toMatchObject({
      id,
      state: "staged",
      generation: 7,
      operation: OPERATION,
    });
    store.markPending(id);
    expect(store.get(id)).toMatchObject({ state: "pending" });
  });

  it("removes a staged record when approval submission fails", () => {
    const { kv } = storage();
    const store = new XActionStore(kv);
    const id = store.stage(OPERATION, 1);

    store.removeStaged(id);

    expect(store.get(id)).toBeUndefined();
  });

  it("claims before dispatch and allows one concurrent apply", async () => {
    const { kv } = storage();
    const store = new XActionStore(kv);
    const id = store.stage(OPERATION, 3);
    store.markPending(id);
    const dispatched = deferred<XWriteResult>();
    const perform = vi.fn(async () => await dispatched.promise);

    const first = store.apply(id, perform);
    await vi.waitFor(() => expect(perform).toHaveBeenCalledOnce());
    expect(store.get(id)).toMatchObject({ state: "applying" });
    await expect(store.apply(id, perform)).rejects.toThrow(/actively applying/i);
    expect(perform).toHaveBeenCalledOnce();

    dispatched.resolve({ status: "applied" });
    await expect(first).resolves.toBeUndefined();
    expect(store.get(id)).toEqual({ id, state: "applied" });
  });

  it("turns an applying record found after re-instantiation into outcome unknown without dispatch", async () => {
    const record: XActionRecord = {
      id: 4,
      state: "applying",
      generation: 2,
      operation: OPERATION,
    };
    const { kv } = storage([
      ["action:4", record],
      ["nextActionId", 5],
    ]);
    const store = new XActionStore(kv);
    const perform = vi.fn(async () => ({ status: "applied" as const }));

    await expect(store.apply(4, perform)).rejects.toThrow(/outcome is unknown/i);

    expect(perform).not.toHaveBeenCalled();
    expect(store.get(4)).toEqual({ id: 4, state: "outcome-unknown" });
  });

  it.each([
    [{ status: "stale" } as XWriteResult, "stale"],
    [{ status: "failed", message: "X rejected the action." } as XWriteResult, "failed"],
    [{ status: "outcome-unknown", message: "X may have applied the action." } as XWriteResult, "outcome-unknown"],
  ])("persists terminal %s results without a private payload", async (result, state) => {
    const { kv } = storage();
    const store = new XActionStore(kv);
    const id = store.stage(OPERATION, 1);
    store.markPending(id);

    await expect(store.apply(id, async () => result)).rejects.toThrow();

    expect(store.get(id)).toMatchObject({ id, state });
    expect(store.get(id)).not.toHaveProperty("operation");
    expect(store.get(id)).not.toHaveProperty("generation");
  });

  it("rejects a pending action and erases its payload", () => {
    const { kv } = storage();
    const store = new XActionStore(kv);
    const id = store.stage(OPERATION, 1);
    store.markPending(id);

    store.reject(id);

    expect(store.get(id)).toEqual({ id, state: "rejected" });
  });

  it("queues after staging and marks pending only after approval submission", async () => {
    const { kv } = storage();
    const store = new XActionStore(kv);
    const getGeneration = vi.fn(async () => 9);
    const submitAction = vi.fn(async (id: number, _description: ActionDescription) => {
      expect(store.get(id)).toMatchObject({ state: "staged", generation: 9 });
    });
    const queue = { submitAction } as unknown as RpcStub<ApprovalQueue>;
    const description: ActionDescription = {
      title: "Create X post",
      description: "Create a text-only X post.",
      implementsRevert: false,
      awaitDecision: true,
    };

    await expect(queueXAction(
      store,
      { getCredentialGeneration: getGeneration },
      queue,
      OPERATION,
      description,
    )).resolves.toBeUndefined();

    expect(submitAction).toHaveBeenCalledWith(0, description);
    expect(store.get(0)).toMatchObject({ state: "pending", generation: 9 });
  });

  it("removes staged payload when approval submission fails", async () => {
    const { kv } = storage();
    const store = new XActionStore(kv);
    const queue = {
      submitAction: vi.fn(async () => { throw new Error("queue unavailable"); }),
    } as unknown as RpcStub<ApprovalQueue>;

    await expect(queueXAction(
      store,
      { getCredentialGeneration: async () => 1 },
      queue,
      OPERATION,
      {
        title: "Create X post",
        description: "Create a text-only X post.",
        implementsRevert: false,
        awaitDecision: true,
      },
    )).rejects.toThrow("queue unavailable");

    expect(store.get(0)).toBeUndefined();
  });

  it("never redispatches a terminal action", async () => {
    const { kv } = storage();
    const store = new XActionStore(kv);
    const id = store.stage(OPERATION, 1);
    store.markPending(id);
    await store.apply(id, async () => ({ status: "applied" }));
    const perform = vi.fn(async () => ({ status: "applied" as const }));

    await expect(store.apply(id, perform)).rejects.toThrow(/already applied/i);
    expect(perform).not.toHaveBeenCalled();
  });
});
