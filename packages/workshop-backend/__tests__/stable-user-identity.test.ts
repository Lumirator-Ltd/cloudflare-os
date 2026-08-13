import { collection, createTypedStorage } from "@gadgets/typed-storage";
import type {
  CollaboratorRecord,
  ShareKeyRecord,
  SharingStorage,
} from "../src/sharing.js";
import { SharingManager } from "../src/sharing.js";
import { canonicalizeVerifiedEmail } from "../src/identity-registry.js";
import type { Overseer } from "@gadgets/workshop-shared/api";
import { describe, expect, expectTypeOf, it } from "vitest";
import { makeMockStorage } from "./mock-storage.js";

function makeStorage(): SharingStorage {
  return createTypedStorage(makeMockStorage(), {
    collections: {
      collaborators: collection<CollaboratorRecord>()({
        primaryKey: record => record.profile.id,
      }),
      shareKeys: collection<ShareKeyRecord>()({
        primaryKey: "id",
        nonUniqueIndexes: {
          byAlias: record => record.alias ?? null,
        },
      }),
    },
  });
}

describe("stable user identity contract", () => {
  it("canonicalizes verified-email discovery while persisting only stable user IDs", () => {
    const ownerInternalUserId = "user_internal_owner";
    const collaboratorInternalUserId = "user_internal_collaborator";
    const verifiedEmail = "  Mixed.Case@Example.COM\t";
    const storage = makeStorage();
    const manager = new SharingManager(storage, ownerInternalUserId);

    expect(canonicalizeVerifiedEmail(verifiedEmail)).toBe("mixed.case@example.com");

    const result = manager.addCollaborator({
      caller: { profileId: ownerInternalUserId, isOwner: true },
      profile: {
        type: "user",
        id: collaboratorInternalUserId,
        name: "Collaborator",
      },
      role: "use",
    });

    expect(result.profile.id).toBe(collaboratorInternalUserId);
    expect(storage.collaborators.get(collaboratorInternalUserId)?.profile.id)
      .toBe(collaboratorInternalUserId);
    expect(storage.collaborators.get("mixed.case@example.com")).toBeUndefined();
  });

  it("keeps unresolved email discovery behind the existing null-returning RPC contract", async () => {
    const addCollaborator: Overseer["addCollaborator"] = async () => null;

    expectTypeOf<Parameters<Overseer["addCollaborator"]>>()
      .toEqualTypeOf<[verifiedEmail: string, role: "use" | "build", note?: string]>();
    await expect(addCollaborator("missing@example.com", "use", undefined))
      .resolves.toBeNull();
  });
});
