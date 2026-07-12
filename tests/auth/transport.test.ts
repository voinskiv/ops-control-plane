import { afterEach, describe, expect, it, vi } from "vitest";

import { getAuthTransport, setAuthTransportForTests } from "@core/auth/transport";

function accessToken(method: string): string {
  const payload = Buffer.from(JSON.stringify({ amr: [{ method, timestamp: 1 }] })).toString("base64url");
  return `header.${payload}.signature`;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAuthTransportForTests(null);
});

describe("Supabase Auth identity parsing (DEC-013 item 7, DEC-014 item 1)", () => {
  it("reads Google verification only from identities[].identity_data and ignores user_metadata", async () => {
    vi.stubEnv("SUPABASE_URL", "https://project.supabase.test");
    vi.stubEnv("SUPABASE_ANON_KEY", "publishable-test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: "00000000-0000-4000-8000-000000000001",
          email: "top-level@example.test",
          user_metadata: { email: "attacker@example.test", email_verified: true },
          identities: [
            {
              provider: "google",
              identity_data: { email: "provider@example.test", email_verified: false },
            },
          ],
        }),
      ),
    );

    await expect(getAuthTransport().userFromAccessToken(accessToken("oauth"))).resolves.toEqual({
      id: "00000000-0000-4000-8000-000000000001",
      email: "top-level@example.test",
      authenticationMethods: ["oauth"],
      identities: [
        {
          provider: "google",
          identityData: { email: "provider@example.test", emailVerified: false },
        },
      ],
    });
  });
});
