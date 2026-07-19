import { afterEach, describe, expect, it, vi } from "vitest";

import { handleGoogleInvitePost, handleGoogleSignInGet, handleMagicLinkPost } from "@core/auth/http";
import { DashboardAuth } from "@core/auth/session";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const personId = "00000000-0000-4000-8000-000000000002";

afterEach(() => {
  vi.unstubAllEnvs();
});

function dashboardAuth(): DashboardAuth {
  return new DashboardAuth(null as never, () => null as never);
}

describe("auth HTTP redirect targets", () => {
  it("returns a relative Location after sending a magic link", async () => {
    const auth = {
      sendMagicLink: vi.fn(async () => ({ status: "ok", result: null, warnings: [] })),
    } as unknown as DashboardAuth;
    const request = new Request("http://0.0.0.0:3000/api/auth/magic-link", {
      method: "POST",
      body: new URLSearchParams({ email: "owner@example.test" }),
    });

    const response = await handleMagicLinkPost(auth, request);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login?sent=1");
  });

  it("uses the configured app origin for the Google sign-in callback", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test");
    vi.stubEnv("SUPABASE_URL", "https://project.supabase.test");

    const response = handleGoogleSignInGet(
      dashboardAuth(),
      new Request("http://0.0.0.0:3000/api/auth/google"),
    );
    const redirectTo = new URL(response.headers.get("location") ?? "").searchParams.get("redirect_to");

    expect(redirectTo).toBe("https://app.example.test/auth/session");
  });

  it("uses the configured app origin for the Google invite callback", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test");
    vi.stubEnv("SUPABASE_URL", "https://project.supabase.test");
    const request = new Request("http://0.0.0.0:3000/api/auth/google/invite", {
      method: "POST",
      body: new URLSearchParams({ workspace_id: workspaceId, person_id: personId }),
    });

    const response = await handleGoogleInvitePost(dashboardAuth(), request);
    const redirectTo = new URL(response.headers.get("location") ?? "").searchParams.get("redirect_to");
    const callback = new URL(redirectTo ?? "");

    expect(callback.origin).toBe("https://app.example.test");
    expect(callback.pathname).toBe("/auth/google/callback");
    expect(callback.searchParams.get("state")).toBeTruthy();
  });
});
