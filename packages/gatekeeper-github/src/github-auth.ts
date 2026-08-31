import { GitHubApi, GitHubApiError } from "./github-api";

const RECONNECT_MESSAGE =
  "GitHub credentials have expired or been revoked. Please reconnect the account.";

export type GitHubCredentialSnapshot = {
  accessToken: string;
  generation: number;
};

export type GitHubCredentialAccount = {
  getCredentials(): GitHubCredentialSnapshot | PromiseLike<GitHubCredentialSnapshot>;
  noteCredentialsExpired(generation: number): void | PromiseLike<void>;
};

export type GitHubCredentialExpiryState = {
  getGeneration(): number;
  getNotified(): boolean;
  setNotified(value: boolean): void;
};

/**
 * Delivers an expiry notification only for the credential generation that failed. The delivered
 * latch is written after the callback succeeds so a transient RPC failure can be retried.
 */
export async function notifyGitHubCredentialsExpired(
  state: GitHubCredentialExpiryState,
  expectedGeneration: number,
  notify: (() => void | PromiseLike<void>) | undefined,
): Promise<void> {
  if (state.getGeneration() !== expectedGeneration || state.getNotified()) return;
  if (notify) await notify();
  if (state.getGeneration() === expectedGeneration) state.setNotified(true);
}

export async function withAuthenticatedGitHubApi<T>(
  account: GitHubCredentialAccount,
  operation: (api: GitHubApi) => Promise<T>,
): Promise<T> {
  const credentials = await account.getCredentials();
  const api = new GitHubApi(async () => credentials.accessToken);
  try {
    return await operation(api);
  } catch (error) {
    if (error instanceof GitHubApiError && error.isAuthError) {
      try {
        await account.noteCredentialsExpired(credentials.generation);
      } catch {
        // Notification delivery is retried by later 401s. Never replace reconnect guidance with an
        // internal callback/RPC failure.
      }
      throw new Error(RECONNECT_MESSAGE, { cause: error });
    }
    throw error;
  }
}

export async function checkAuthenticatedGitHubRepoAccess(
  account: GitHubCredentialAccount,
  owner: string,
  repo: string,
): Promise<boolean> {
  try {
    await withAuthenticatedGitHubApi(account, async api => await api.getRepo(owner, repo));
    return true;
  } catch (error) {
    // GitHub returns 404 for inaccessible private repositories and may return 403 for organization
    // policy failures. Authentication 401s have already been converted to reconnect guidance.
    if (error instanceof GitHubApiError && (error.status === 404 || error.status === 403)) {
      return false;
    }
    throw error;
  }
}
