import { RpcStub } from "cloudflare:workers";
import type {
  ApprovalQueue,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, describe, expect, it, vi } from "vitest";
import { XAccountSessionImpl, type XReadOperation } from "../src/x";
import type { XWriteOperation } from "../src/x-actions";
import type { XPostPage, XUserPage } from "../src/x-api-client";

const USER = { id: "2244994945", name: "X Developer", username: "XDevelopers" };
const POST = { id: "1346889436626259968", text: "private post text", authorId: USER.id };
const POST_PAGE: XPostPage = { data: [POST], users: [USER], nextToken: "NEXT_123" };
const USER_PAGE: XUserPage = { data: [USER], nextToken: "NEXT_123" };

type Authorize = ReturnType<
  typeof vi.fn<(description: ObservationDescription) => Promise<void>>
>;

type Account = {
  performRead(operation: XReadOperation): Promise<unknown>;
};

type ActionHost = {
  queueAction(
    queue: RpcStub<ApprovalQueue>,
    operation: XWriteOperation,
    description: Parameters<ApprovalQueue["submitAction"]>[1],
  ): Promise<void>;
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function subject(options: {
  performRead?: (operation: XReadOperation) => Promise<unknown>;
  authorize?: Authorize;
} = {}) {
  const operations: XReadOperation[] = [];
  const performRead = vi.fn(async (operation: XReadOperation) => {
    operations.push(operation);
    if (options.performRead) return await options.performRead(operation);
    switch (operation.type) {
      case "getMe":
      case "getUser": return USER;
      case "getPost": return POST;
      case "listFollowers":
      case "listFollowing": return USER_PAGE;
      default: return POST_PAGE;
    }
  });
  const authorize = options.authorize ?? vi.fn(async () => {});
  const dispose = vi.fn();
  const queue = {
    authorizeObservation: authorize,
    submitAction: vi.fn(),
    [Symbol.dispose]: dispose,
  } as unknown as RpcStub<ApprovalQueue>;
  const queued: Array<{
    operation: XWriteOperation;
    description: Parameters<ApprovalQueue["submitAction"]>[1];
  }> = [];
  const queueAction = vi.fn(async (
    _queue: RpcStub<ApprovalQueue>,
    operation: XWriteOperation,
    description: Parameters<ApprovalQueue["submitAction"]>[1],
  ) => { queued.push({ operation, description }); });
  const value = new XAccountSessionImpl(
    { performRead } as unknown as Account,
    queue,
    { queueAction } as ActionHost,
  );
  return { authorize, dispose, operations, performRead, queueAction, queued, value };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("X account observations", () => {
  it("fetches first and withholds data until observation authorization resolves", async () => {
    const read = deferred<unknown>();
    const authorization = deferred<void>();
    const authorize = vi.fn(async () => await authorization.promise);
    const session = subject({
      performRead: async () => await read.promise,
      authorize,
    });
    let returned = false;

    const result = session.value.getPost(POST.id).then(value => {
      returned = true;
      return value;
    });

    await vi.waitFor(() => expect(session.performRead).toHaveBeenCalledOnce());
    expect(authorize).not.toHaveBeenCalled();
    read.resolve(POST);
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
    expect(returned).toBe(false);

    authorization.resolve();
    await expect(result).resolves.toEqual(POST);
  });

  it("returns no fetched data when observation authorization rejects", async () => {
    const rejection = new Error("observation rejected");
    const session = subject({
      authorize: vi.fn(async () => { throw rejection; }),
    });

    await expect(session.value.listBookmarks()).rejects.toBe(rejection);
    expect(session.performRead).toHaveBeenCalledOnce();
  });

  it("maps every read to one closed account operation", async () => {
    const session = subject();

    await session.value.getMe();
    await session.value.getUser({ username: USER.username });
    await session.value.getPost(POST.id);
    await session.value.listMyPosts({ maxResults: 20, nextToken: "PAGE" });
    await session.value.listMentions();
    await session.value.listHomeTimeline();
    await session.value.searchRecent("secret search", { maxResults: 10 });
    await session.value.listLikedPosts();
    await session.value.listBookmarks();
    await session.value.listFollowers();
    await session.value.listFollowing();

    expect(session.operations).toEqual([
      { type: "getMe" },
      { type: "getUser", input: { username: USER.username } },
      { type: "getPost", id: POST.id },
      { type: "listMyPosts", options: { maxResults: 20, nextToken: "PAGE" } },
      { type: "listMentions", options: undefined },
      { type: "listHomeTimeline", options: undefined },
      { type: "searchRecent", query: "secret search", options: { maxResults: 10 } },
      { type: "listLikedPosts", options: undefined },
      { type: "listBookmarks", options: undefined },
      { type: "listFollowers", options: undefined },
      { type: "listFollowing", options: undefined },
    ]);
    expect(session.authorize).toHaveBeenCalledTimes(11);
  });

  it("keeps search text and full post text out of durable observation descriptions", async () => {
    const session = subject();

    await session.value.searchRecent("confidential acquisition", { maxResults: 10 });
    await session.value.getPost(POST.id);

    const descriptions = session.authorize.mock.calls.map(([description]) =>
      `${description.title}\n${description.description}`);
    expect(descriptions.join("\n")).not.toContain("confidential acquisition");
    expect(descriptions.join("\n")).not.toContain(POST.text);
    expect(descriptions[0]).toContain("1");
    expect(descriptions[1]).toContain(POST.id);
  });

  it("uses bounded result metadata in list descriptions", async () => {
    const session = subject();

    await session.value.listFollowers();
    await session.value.listMyPosts();

    expect(session.authorize.mock.calls[0][0]).toMatchObject({
      title: "Read 1 X follower",
    });
    expect(session.authorize.mock.calls[1][0]).toMatchObject({
      title: "Read 1 X post",
    });
  });

  it("disposes the duplicated approval queue with the session", () => {
    const session = subject();

    session.value[Symbol.dispose]();

    expect(session.dispose).toHaveBeenCalledOnce();
  });
});

describe("X account mutations", () => {
  it.each([
    ["createPost", ["Announcement"], { type: "createPost", text: "Announcement" }, "Create X post"],
    ["reply", ["Reply", POST.id], { type: "reply", text: "Reply", postId: POST.id }, `Reply to X post ${POST.id}`],
    ["deletePost", [POST.id], { type: "deletePost", postId: POST.id }, `Delete X post ${POST.id}`],
    ["like", [POST.id], { type: "like", postId: POST.id }, `Like X post ${POST.id}`],
    ["unlike", [POST.id], { type: "unlike", postId: POST.id }, `Unlike X post ${POST.id}`],
    ["bookmark", [POST.id], { type: "bookmark", postId: POST.id }, `Bookmark X post ${POST.id}`],
    ["removeBookmark", [POST.id], { type: "removeBookmark", postId: POST.id }, `Remove X bookmark ${POST.id}`],
    ["follow", [USER.id], { type: "follow", userId: USER.id }, `Follow X user ${USER.id}`],
    ["unfollow", [USER.id], { type: "unfollow", userId: USER.id }, `Unfollow X user ${USER.id}`],
  ])("queues %s without applying it", async (method, args, operation, title) => {
    const session = subject();

    await (session.value[method as keyof XAccountSessionImpl] as (
      ...values: string[]
    ) => Promise<void>)(...args);

    expect(session.queueAction).toHaveBeenCalledOnce();
    expect(session.queued).toEqual([{
      operation,
      description: expect.objectContaining({
        title,
        implementsRevert: false,
        awaitDecision: true,
      }),
    }]);
    expect(session.queued[0].description).not.toHaveProperty("autoApprovable");
    expect(session.queued[0].description).not.toHaveProperty("actionKind");
    expect(session.performRead).not.toHaveBeenCalled();
  });

  it("includes the complete post text as inert approval content", async () => {
    const session = subject();
    const text = "First line\n# forged heading\n```forged fence```";

    await session.value.createPost(text);

    const description = session.queued[0].description.description;
    expect(description).toContain("    First line");
    expect(description).toContain("    # forged heading");
    expect(description).toContain("    ```forged fence```");
    expect(description).not.toMatch(/^# forged heading/m);
    expect(description).not.toMatch(/^```forged fence/m);
  });

  it.each([
    [() => subject().value.createPost(""), "text"],
    [() => subject().value.createPost("x".repeat(4001)), "text"],
    [() => subject().value.reply("reply", "https://evil.test"), "id"],
    [() => subject().value.deletePost("1/../2"), "id"],
    [() => subject().value.follow("../../1"), "id"],
  ])("rejects invalid mutation input before queueing", async (operation, message) => {
    await expect(operation()).rejects.toThrow(new RegExp(message, "i"));
  });
});
