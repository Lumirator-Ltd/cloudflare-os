import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type {
  GatekeeperConnectCallback,
  GatekeeperUser,
} from "@gadgets/workshop-shared/gatekeeper";
import { HubSpotApi } from "../src/hubspot-api";
import { HubSpotGatekeeperImpl } from "../src/hubspot";

export { default } from "../src/hubspot";
export {
  GatekeeperUserImpl,
  GatekeeperVendor,
  HubSpotGatekeeperImpl,
  HubSpotVerifier,
  UserAccount,
} from "../src/hubspot";

export class TestHubSpotGatekeeper extends HubSpotGatekeeperImpl {
  protected mutationApi(): HubSpotApi {
    return new HubSpotApi({ getAccessToken: async () => "test-hubspot-token" });
  }
}

type CallbackState = {
  completeCount: number;
  completeExpiry?: number;
  completedDescription?: { displayName?: string; uniqueName?: string };
  expiredCount: number;
  restoredCount: number;
  restoredExpiry?: number;
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

  async complete(user: Fetcher<GatekeeperUser>, expiresAt?: Date): Promise<void> {
    this.ctx.storage.kv.put("user", user);
    const description = await user.describe();
    const state = this.#state();
    state.completeCount++;
    state.completeExpiry = expiresAt?.valueOf();
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

  credentialsRestored(expiresAt?: Date): void {
    const state = this.#state();
    state.restoredCount++;
    state.restoredExpiry = expiresAt?.valueOf();
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
    if (!user) throw new Error("No connected HubSpot account");
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

  async validateConnectedUrl(url: string): Promise<string> {
    const result = await this.#user().getGatekeeperClassFor(url);
    return result.resource.title;
  }

  async configuredResourceUrl(pattern: string): Promise<string> {
    const frame = await this.#user().startResourceConfigurator(pattern);
    try {
      const ui = frame.ui as Fetcher<{ resourceUrl(): Promise<string> }>;
      return await ui.resourceUrl();
    } finally {
      frame.ui[Symbol.dispose]();
    }
  }

  async verifyConnected(): Promise<void> {
    const verifier = await this.#user().getVerifier() as Fetcher<{ verify(): Promise<void> }>;
    try {
      await verifier.verify();
    } finally {
      verifier[Symbol.dispose]();
    }
  }
}

export class TestConnectCallback extends WorkerEntrypoint implements GatekeeperConnectCallback {
  #store(): DurableObjectStub<TestCallbackStore> {
    return this.ctx.exports.TestCallbackStore.getByName("callback");
  }

  async complete(user: Fetcher<GatekeeperUser>, expiresAt?: Date): Promise<void> {
    await this.#store().complete(user, expiresAt);
  }

  async credentialsExpired(): Promise<void> {
    await this.#store().credentialsExpired();
  }

  async credentialsRestored(expiresAt?: Date): Promise<void> {
    await this.#store().credentialsRestored(expiresAt);
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

  validateConnectedUrl(url: string): Promise<string> {
    return this.#store().validateConnectedUrl(url);
  }

  configuredResourceUrl(pattern: string): Promise<string> {
    return this.#store().configuredResourceUrl(pattern);
  }

  verifyConnected(): Promise<void> {
    return this.#store().verifyConnected();
  }
}
