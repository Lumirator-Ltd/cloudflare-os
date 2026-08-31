export interface XPageOptions {
  /** Number of records to request. Defaults to 10 and cannot exceed 20. */
  maxResults?: number;
  /** Opaque next-page token returned by the preceding call. */
  nextToken?: string;
}

export interface XUser {
  id: string;
  name: string;
  username: string;
  description?: string;
  profileImageUrl?: string;
  protected?: boolean;
  verified?: boolean;
  createdAt?: string;
  publicMetrics?: Record<string, number>;
}

export interface XPostReference {
  type: string;
  id: string;
}

export interface XPost {
  id: string;
  text: string;
  authorId?: string;
  createdAt?: string;
  conversationId?: string;
  inReplyToUserId?: string;
  lang?: string;
  referencedPosts?: XPostReference[];
  publicMetrics?: Record<string, number>;
}

export interface XPostPage {
  data: XPost[];
  /** Expanded users referenced by posts in this page. */
  users: XUser[];
  nextToken?: string;
}

export interface XUserPage {
  data: XUser[];
  nextToken?: string;
}

/** Whole-account X API. Every read consumes the connected user's X API credits. */
export interface XAccountSession {
  getMe(): Promise<XUser>;
  getUser(input: { id?: string; username?: string }): Promise<XUser>;
  getPost(id: string): Promise<XPost>;
  listMyPosts(options?: XPageOptions): Promise<XPostPage>;
  listMentions(options?: XPageOptions): Promise<XPostPage>;
  listHomeTimeline(options?: XPageOptions): Promise<XPostPage>;
  searchRecent(query: string, options?: XPageOptions): Promise<XPostPage>;
  listLikedPosts(options?: XPageOptions): Promise<XPostPage>;
  listBookmarks(options?: XPageOptions): Promise<XPostPage>;
  listFollowers(options?: XPageOptions): Promise<XUserPage>;
  listFollowing(options?: XPageOptions): Promise<XUserPage>;

  /** Queues a text-only post for owner approval. */
  createPost(text: string): Promise<void>;
  /** Queues a text-only reply for owner approval. */
  reply(text: string, postId: string): Promise<void>;
  deletePost(postId: string): Promise<void>;
  like(postId: string): Promise<void>;
  unlike(postId: string): Promise<void>;
  bookmark(postId: string): Promise<void>;
  removeBookmark(postId: string): Promise<void>;
  follow(userId: string): Promise<void>;
  unfollow(userId: string): Promise<void>;
}
