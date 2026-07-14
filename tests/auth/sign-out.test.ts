import { afterEach, describe, expect, it, vi } from "vitest";

import { handleSignOutPost } from "@core/auth/http";
import {
  AUTH_TOKEN_COOKIE,
  DashboardAuth,
  WORKSPACE_COOKIE,
  type CookieChange,
} from "@core/auth/session";
import { getAuthTransport, setAuthTransportForTests, type AuthTransport } from "@core/auth/transport";
import { completeExplicitSignOut, type ExplicitSignOutClient } from "../../app/sign-out-client";
import de from "../../core/i18n/de.json";
import en from "../../core/i18n/en.json";

const accessToken = "signed-in-access-token";
const workspaceId = "00000000-0000-4000-8000-000000000001";

function auth(): DashboardAuth {
  return new DashboardAuth(
    {
      withClient: async () => {
        throw new Error("unexpected auth db read");
      },
      withWorkspace: async () => {
        throw new Error("unexpected workspace db read");
      },
      end: async () => undefined,
    },
    () => {
      throw new Error("unexpected kernel access");
    },
  );
}

function cookieLine(changes: CookieChange[]): string {
  return changes.map((cookie) => `${cookie.name}=${encodeURIComponent(cookie.value)}`).join("; ");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAuthTransportForTests(null);
});

describe("SLICE-015C explicit sign-out (DEC-026 items 2-4)", () => {
  it("revokes the local Supabase session and clears both app cookies in a typed envelope", async () => {
    const revoked: string[] = [];
    const transport: AuthTransport = {
      async sendInvite() {
        throw new Error("unexpected invite");
      },
      async sendMagicLink() {
        throw new Error("unexpected magic link");
      },
      async userFromAccessToken() {
        throw new Error("unexpected identity lookup");
      },
      async revokeSession(token) {
        revoked.push(token);
      },
    };
    setAuthTransportForTests(transport);

    const response = await handleSignOutPost(
      auth(),
      new Request("https://app.example.test/api/auth/sign-out", {
        method: "POST",
        headers: {
          cookie: `${AUTH_TOKEN_COOKIE}=${accessToken}; ${WORKSPACE_COOKIE}=${workspaceId}`,
        },
      }),
    );

    expect(revoked).toEqual([accessToken]);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok", result: null, warnings: [] });
    const setCookies = response.headers.getSetCookie();
    expect(setCookies).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${AUTH_TOKEN_COOKIE}=;`),
        expect.stringContaining(`${WORKSPACE_COOKIE}=;`),
      ]),
    );
    expect(setCookies.every((cookie) => cookie.includes("Max-Age=0"))).toBe(true);
  });

  it("does not resolve an actor from the cookies returned by sign-out", async () => {
    setAuthTransportForTests({
      async sendInvite() {
        throw new Error("unexpected invite");
      },
      async sendMagicLink() {
        throw new Error("unexpected magic link");
      },
      async userFromAccessToken() {
        throw new Error("unexpected identity lookup");
      },
      async revokeSession() {
        return undefined;
      },
    });
    const dashboardAuth = auth();
    const signedOut = await dashboardAuth.signOut(
      `${AUTH_TOKEN_COOKIE}=${accessToken}; ${WORKSPACE_COOKIE}=${workspaceId}`,
    );

    await expect(dashboardAuth.resolveActor(cookieLine(signedOut.cookies))).resolves.toMatchObject({
      actor: null,
      rejection: "unauthenticated",
    });
  });

  it("calls the Supabase logout endpoint with local scope through the existing transport", async () => {
    vi.stubEnv("SUPABASE_URL", "https://project.supabase.test");
    vi.stubEnv("SUPABASE_ANON_KEY", "publishable-test-key");
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const revokeSession = getAuthTransport().revokeSession;
    expect(revokeSession).toBeTypeOf("function");
    await revokeSession?.(accessToken);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://project.supabase.test/auth/v1/logout?scope=local",
      expect.objectContaining({
        method: "POST",
        headers: {
          apikey: "publishable-test-key",
          authorization: `Bearer ${accessToken}`,
        },
      }),
    );
  });

  it("purges both capture caches before redirecting on the explicit sign-out path", async () => {
    const events: string[] = [];
    const client: ExplicitSignOutClient = {
      async request() {
        events.push("request");
        return Response.json({ status: "ok", result: null, warnings: [] });
      },
      async deleteCache(name) {
        events.push(`delete:${name}`);
        return true;
      },
      redirect() {
        events.push("redirect:/login");
      },
    };

    await expect(completeExplicitSignOut(client)).resolves.toBe(true);
    expect(events).toEqual([
      "request",
      "delete:ops-control-plane-shell-v1",
      "delete:ops-control-plane-day-pack-v1",
      "redirect:/login",
    ]);
  });

  it("defines the sign-out label in both catalogs", () => {
    expect(de.auth.sign_out).toBe("Abmelden");
    expect(en.auth.sign_out).toBe("Sign out");
  });
});
