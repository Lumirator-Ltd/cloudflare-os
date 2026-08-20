import { GitHubApi, GitHubApiError } from "./github-api";

const RECONNECT_MESSAGE =
  "GitHub credentials have expired or been revoked. Please reconnect the account.";

export type GitHubCredentialAccount = {
  getAccessToken(): string | PromiseLike<string>;
  noteCredentialsExpired(): void | PromiseLike<void>;
};

export async function withAuthenticatedGitHubApi<T>(
  account: GitHubCredentialAccount,
  operation: (api: GitHubApi) => Promise<T>,
): Promise<T> {
  const api = new GitHubApi(async () => await account.getAccessToken());
  try {
    return await operation(api);
  } catch (error) {
    if (error instanceof GitHubApiError && error.isAuthError) {
      await account.noteCredentialsExpired();
      throw new Error(RECONNECT_MESSAGE, { cause: error });
    }
    throw error;
  }
}
