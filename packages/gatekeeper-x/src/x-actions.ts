import type { RpcStub } from "cloudflare:workers";
import type {
  ActionDescription,
  ApprovalQueue,
} from "@gadgets/workshop-shared/gatekeeper";

export type XWriteOperation =
  | { type: "createPost"; text: string }
  | { type: "reply"; text: string; postId: string }
  | { type: "deletePost"; postId: string }
  | { type: "like"; postId: string }
  | { type: "unlike"; postId: string }
  | { type: "bookmark"; postId: string }
  | { type: "removeBookmark"; postId: string }
  | { type: "follow"; userId: string }
  | { type: "unfollow"; userId: string };

export type XWriteResult =
  | { status: "applied" }
  | { status: "stale" }
  | { status: "failed"; message: string }
  | { status: "outcome-unknown"; message: string };

type ActiveState = "staged" | "pending" | "applying";
type TerminalState = "applied" | "rejected" | "failed" | "stale" | "outcome-unknown";

export type XActionRecord = {
  id: number;
  state: ActiveState;
  generation: number;
  operation: XWriteOperation;
} | {
  id: number;
  state: TerminalState;
};

type ActionKv = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
};

const MAX_ACTION_ID = Number.MAX_SAFE_INTEGER;

function actionKey(id: number): string {
  return `action:${id}`;
}

export async function queueXAction(
  store: XActionStore,
  account: { getCredentialGeneration(): Promise<number> },
  queue: RpcStub<ApprovalQueue>,
  operation: XWriteOperation,
  description: ActionDescription,
): Promise<void> {
  const generation = await account.getCredentialGeneration();
  const id = store.stage(operation, generation);
  try {
    await queue.submitAction(id, description);
  } catch (error) {
    store.removeStaged(id);
    throw error;
  }
  store.markPending(id);
}

export class XActionStore {
  readonly #active = new Set<number>();

  constructor(private readonly kv: ActionKv) {}

  get(id: number): XActionRecord | undefined {
    return this.kv.get<XActionRecord>(actionKey(id));
  }

  stage(operation: XWriteOperation, generation: number): number {
    const id = this.kv.get<number>("nextActionId") ?? 0;
    if (!Number.isSafeInteger(id) || id < 0 || id >= MAX_ACTION_ID) {
      throw new Error("X action ID space is exhausted.");
    }
    this.kv.put("nextActionId", id + 1);
    this.kv.put<XActionRecord>(actionKey(id), {
      id,
      state: "staged",
      generation,
      operation,
    });
    return id;
  }

  markPending(id: number): void {
    const record = this.#require(id);
    if (record.state !== "staged") throw new Error(`X action ${id} is not staged.`);
    this.kv.put<XActionRecord>(actionKey(id), { ...record, state: "pending" });
  }

  removeStaged(id: number): void {
    const record = this.get(id);
    if (record?.state === "staged") this.kv.delete(actionKey(id));
  }

  reject(id: number): void {
    const record = this.#require(id);
    if (record.state !== "pending" && record.state !== "staged") {
      throw new Error(`X action ${id} is already ${record.state}.`);
    }
    this.kv.put<XActionRecord>(actionKey(id), { id, state: "rejected" });
  }

  async apply(
    id: number,
    perform: (input: { operation: XWriteOperation; generation: number }) => Promise<XWriteResult>,
  ): Promise<void> {
    if (this.#active.has(id)) throw new Error(`X action ${id} is actively applying.`);
    const record = this.#require(id);
    if (record.state === "applying") {
      this.kv.put<XActionRecord>(actionKey(id), { id, state: "outcome-unknown" });
      throw new Error(`X action ${id} outcome is unknown and will not be retried.`);
    }
    if (record.state !== "pending") {
      throw new Error(`X action ${id} is already ${record.state}.`);
    }

    const applying: XActionRecord = { ...record, state: "applying" };
    this.kv.put(actionKey(id), applying);
    this.#active.add(id);
    try {
      let result: XWriteResult;
      try {
        result = await perform({
          operation: applying.operation,
          generation: applying.generation,
        });
      } catch (error) {
        this.kv.put<XActionRecord>(actionKey(id), { id, state: "outcome-unknown" });
        throw new Error(`X action ${id} outcome is unknown and will not be retried.`, {
          cause: error,
        });
      }

      if (result.status === "applied") {
        this.kv.put<XActionRecord>(actionKey(id), { id, state: "applied" });
        return;
      }
      this.kv.put<XActionRecord>(actionKey(id), { id, state: result.status });
      const message = result.status === "stale"
        ? `X action ${id} is stale because the connected Developer App changed.`
        : result.message;
      throw new Error(message);
    } finally {
      this.#active.delete(id);
    }
  }

  #require(id: number): XActionRecord {
    const record = this.get(id);
    if (!record) throw new Error(`Unknown X action: ${id}.`);
    return record;
  }
}
