import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type {
  GatekeeperConnectCallback,
  GatekeeperUser,
} from "@gadgets/workshop-shared/gatekeeper";

export { default } from "../src/x";
export {
  GatekeeperVendor,
  UserAccount,
  XAccountGatekeeperImpl,
  XGatekeeperUser,
  XVerifier,
} from "../src/x";

type CallbackState = {
  completeCount: number;
  expiredCount: number;
  restoredCount: number;
  completedDescription?: { displayName?: string; uniqueName?: string };
};

const EMPTY_STATE: CallbackState = {
  completeCount: 0,
  expiredCount: 0,
  restoredCount: 0,
};

export class TestCallbackStore extends DurableObject {
  #state(): CallbackState {
    return this.ctx.storage.kv.get<CallbackState>("state") ?? structuredClone(EMPTY_STATE);
  }

  async complete(user: Fetcher<GatekeeperUser>): Promise<void> {
    this.ctx.storage.kv.put("user", user);
    const description = await user.describe();
    const state = this.#state();
    state.completeCount++;
    state.completedDescription = {
      displayName: description.displayName,
      uniqueName: description.uniqueName,
    };
    this.ctx.storage.kv.put("state", state);
  }

  credentialsExpired(): void {
    const state = this.#state();
    state.expiredCount++;
    this.ctx.storage.kv.put("state", state);
  }

  credentialsRestored(): void {
    const state = this.#state();
    state.restoredCount++;
    this.ctx.storage.kv.put("state", state);
  }

  read(): CallbackState {
    return this.#state();
  }

  async reset(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  #user(): Fetcher<GatekeeperUser> {
    const user = this.ctx.storage.kv.get<Fetcher<GatekeeperUser>>("user");
    if (!user) throw new Error("No connected X account");
    return user;
  }

  describeConnected(): Promise<Awaited<ReturnType<GatekeeperUser["describe"]>>> {
    return this.#user().describe();
  }

  reconnectConnected(): Promise<{ url: string }> {
    return this.#user().reconnect();
  }

  revokeConnected(): Promise<void> {
    return this.#user().revoke();
  }

  async validateConnectedUrl(url: string): Promise<Record<string, unknown>> {
    const result = await this.#user().getGatekeeperClassFor(url);
    return result.resource;
  }

  async configuredResourceUrl(pattern: string): Promise<string> {
    const frame = await this.#user().startResourceConfigurator(pattern);
    try {
      return await (frame.ui as Fetcher<{ resourceUrl(): Promise<string> }>).resourceUrl();
    } finally {
      frame.ui[Symbol.dispose]();
    }
  }
}

export class TestConnectCallback extends WorkerEntrypoint implements GatekeeperConnectCallback {
  #store(): DurableObjectStub<TestCallbackStore> {
    return this.ctx.exports.TestCallbackStore.getByName("callback");
  }

  complete(user: Fetcher<GatekeeperUser>): Promise<void> {
    return this.#store().complete(user);
  }

  credentialsExpired(): Promise<void> {
    return this.#store().credentialsExpired();
  }

  credentialsRestored(): Promise<void> {
    return this.#store().credentialsRestored();
  }

  read(): Promise<CallbackState> {
    return this.#store().read();
  }

  reset(): Promise<void> {
    return this.#store().reset();
  }

  describeConnected(): Promise<Awaited<ReturnType<GatekeeperUser["describe"]>>> {
    return this.#store().describeConnected();
  }

  reconnectConnected(): Promise<{ url: string }> {
    return this.#store().reconnectConnected();
  }

  revokeConnected(): Promise<void> {
    return this.#store().revokeConnected();
  }

  validateConnectedUrl(url: string): Promise<Record<string, unknown>> {
    return this.#store().validateConnectedUrl(url);
  }

  configuredResourceUrl(pattern: string): Promise<string> {
    return this.#store().configuredResourceUrl(pattern);
  }
}
