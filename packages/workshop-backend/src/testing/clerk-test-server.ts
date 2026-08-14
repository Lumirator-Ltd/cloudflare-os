import { verifyToken as verifyClerkToken } from "@clerk/backend";
import type { ClerkAuthDependencies } from "../clerk-auth.js";
import { verifyClerkIdentity } from "../clerk-auth.js";
import workshopServer from "../server.js";

export * from "../server.js";

type ClerkTestProfiles = {
  getSession(sessionId: string): Promise<{ id: string; userId: string; status: string }>;
  getUser(subject: string): Promise<{
    id: string;
    primaryEmailAddress: {
      emailAddress: string;
      verification: { status: string };
    };
  }>;
};

type TestEnv = Cloudflare.Env & {
  TEST_CLERK_PROFILES: ClerkTestProfiles;
};

function testDependencies(profiles: ClerkTestProfiles): ClerkAuthDependencies {
  return {
    verifyToken: verifyClerkToken,
    createClient: () => ({
      sessions: { getSession: sessionId => profiles.getSession(sessionId) },
      users: { getUser: subject => profiles.getUser(subject) },
    }),
  };
}

// This entry is selected only by the Task5 integration harness. Production releases continue to
// bundle src/server.ts, whose three-argument fetch path always uses the real Clerk Backend client.
export default {
  fetch(request: Request, env: TestEnv, ctx: ExecutionContext) {
    return workshopServer.fetch(request, env, ctx, token =>
      verifyClerkIdentity(token, env, testDependencies(env.TEST_CLERK_PROFILES)));
  },
} satisfies ExportedHandler<TestEnv>;
