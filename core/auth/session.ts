import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { Kernel } from "../actions/kernel";
import { envelopeRejected, type Actor, type RejectionCode, type ResponseEnvelope } from "../actions/types";
import type { AuthDb } from "../db/auth";
import {
  dashboardMembershipByWorkspace,
  dashboardMembershipsByAuthUserId,
  preflightLinkAuthUserToPerson,
  type DashboardMembership,
  type PublicDashboardMembership,
} from "../db/persons";
import { getAuthTransport, googleOAuthUrl, type AuthIdentity } from "./transport";

export const AUTH_TOKEN_COOKIE = "ocp_auth_token";
export const WORKSPACE_COOKIE = "ocp_workspace_id";
export const GOOGLE_INVITE_STATE_COOKIE = "ocp_google_invite_state";

const accessTokenInput = z.string().min(1).max(8192);
const workspaceIdInput = z.uuid();
const personIdInput = z.uuid();
const emailInput = z.string().trim().max(254);
const googleInviteStateInput = z
  .object({
    nonce: z.uuid(),
    workspaceId: z.uuid(),
    personId: z.uuid(),
  })
  .strict();

export interface CookieChange {
  name: typeof AUTH_TOKEN_COOKIE | typeof WORKSPACE_COOKIE | typeof GOOGLE_INVITE_STATE_COOKIE;
  value: string;
  maxAge?: number;
}

export interface SessionResult {
  envelope: ResponseEnvelope;
  cookies: CookieChange[];
}

export interface CurrentSession {
  actor: Extract<Actor, { type: "person" }>;
  membership: DashboardMembership;
}

export interface ActorResolution {
  actor: Actor | null;
  membership?: DashboardMembership;
  rejection?: Extract<RejectionCode, "unauthenticated" | "no_dashboard_membership">;
  cookies: CookieChange[];
}

export interface GoogleInviteStartResult {
  location: string;
  cookies: CookieChange[];
}

interface ParsedCookies {
  accessToken: string | null;
  workspaceId: string | null;
}

function parseCookieHeader(cookieHeader: string | null): ParsedCookies {
  const values = new Map<string, string>();
  for (const part of (cookieHeader ?? "").split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) {
      continue;
    }
    values.set(rawName, decodeURIComponent(rawValue.join("=")));
  }
  return {
    accessToken: values.get(AUTH_TOKEN_COOKIE) ?? null,
    workspaceId: values.get(WORKSPACE_COOKIE) ?? null,
  };
}

export function cookieHeader(change: CookieChange): string {
  const encoded = encodeURIComponent(change.value);
  const maxAge = change.maxAge === undefined ? "" : `; Max-Age=${change.maxAge}`;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${change.name}=${encoded}; Path=/; HttpOnly; SameSite=Lax${secure}${maxAge}`;
}

function setAuthCookie(accessToken: string): CookieChange {
  return { name: AUTH_TOKEN_COOKIE, value: accessToken };
}

function setWorkspaceCookie(workspaceId: string): CookieChange {
  return { name: WORKSPACE_COOKIE, value: workspaceId };
}

function clearAuthCookie(): CookieChange {
  return { name: AUTH_TOKEN_COOKIE, value: "", maxAge: 0 };
}

function clearWorkspaceCookie(): CookieChange {
  return { name: WORKSPACE_COOKIE, value: "", maxAge: 0 };
}

function setGoogleInviteStateCookie(value: string): CookieChange {
  return { name: GOOGLE_INVITE_STATE_COOKIE, value };
}

function clearGoogleInviteStateCookie(): CookieChange {
  return { name: GOOGLE_INVITE_STATE_COOKIE, value: "", maxAge: 0 };
}

function rejected(code: RejectionCode, cookies: CookieChange[] = []): SessionResult {
  return { envelope: envelopeRejected(code), cookies };
}

function actorForMembership(membership: DashboardMembership): Extract<Actor, { type: "person" }> {
  return {
    type: "person",
    id: membership.person_id,
    roleClass: membership.role_class,
    workspaceId: membership.workspace_id,
  };
}

async function identityFromToken(accessToken: string): Promise<AuthIdentity | null> {
  const parsed = accessTokenInput.safeParse(accessToken);
  if (!parsed.success) {
    return null;
  }
  const identity = await getAuthTransport().userFromAccessToken(parsed.data);
  const email = identity === null ? null : emailInput.safeParse(identity.email);
  if (
    identity === null ||
    !workspaceIdInput.safeParse(identity.id).success ||
    email === null ||
    !email.success ||
    email.data.length === 0
  ) {
    return null;
  }
  return identity;
}

function googleIdentityEmail(identity: AuthIdentity): string | null {
  if (!(identity.authenticationMethods ?? []).includes("oauth")) {
    return null;
  }
  const googleIdentity = (identity.identities ?? []).find((candidate) => candidate.provider === "google");
  const email = googleIdentity?.identityData.email;
  if (googleIdentity?.identityData.emailVerified !== true || email === undefined || !emailInput.safeParse(email).success) {
    return null;
  }
  return email.trim().toLowerCase();
}

export class DashboardAuth {
  constructor(
    private readonly authDb: AuthDb,
    private readonly getKernel: () => Kernel,
  ) {}

  async sendMagicLink(email: string): Promise<ResponseEnvelope> {
    const parsed = emailInput.safeParse(email);
    if (!parsed.success || parsed.data.length === 0) {
      return envelopeRejected("validation_failed");
    }
    await getAuthTransport().sendMagicLink({ email: parsed.data });
    return { status: "ok", result: null, warnings: [] };
  }

  startGoogleSignIn(requestUrl: string): string {
    return googleOAuthUrl(new URL("/auth/session", requestUrl).toString());
  }

  startGoogleInvite(requestUrl: string, workspaceIdValue: string, personIdValue: string): GoogleInviteStartResult | null {
    const workspaceId = workspaceIdInput.safeParse(workspaceIdValue);
    const personId = personIdInput.safeParse(personIdValue);
    if (!workspaceId.success || !personId.success) {
      return null;
    }
    const state = {
      nonce: randomUUID(),
      workspaceId: workspaceId.data,
      personId: personId.data,
    };
    const callback = new URL("/auth/google/callback", requestUrl);
    callback.searchParams.set("state", state.nonce);
    return {
      location: googleOAuthUrl(callback.toString()),
      cookies: [setGoogleInviteStateCookie(JSON.stringify(state))],
    };
  }

  async completeGoogleInvite(params: {
    accessToken: string;
    state: string;
    stateCookie: string | null;
  }): Promise<SessionResult> {
    const state = workspaceIdInput.safeParse(params.state);
    const cookieState = (() => {
      try {
        return googleInviteStateInput.safeParse(JSON.parse(params.stateCookie ?? ""));
      } catch {
        return googleInviteStateInput.safeParse(null);
      }
    })();
    if (!state.success || !cookieState.success || state.data !== cookieState.data.nonce) {
      return rejected("validation_failed", [clearGoogleInviteStateCookie(), clearWorkspaceCookie()]);
    }
    const accepted = await this.acceptInvite({
      accessToken: params.accessToken,
      workspaceId: cookieState.data.workspaceId,
      personId: cookieState.data.personId,
      requiredProvider: "google",
    });
    return { ...accepted, cookies: [...accepted.cookies, clearGoogleInviteStateCookie()] };
  }

  async establish(accessToken: string, selectedWorkspaceId?: string): Promise<SessionResult> {
    const identity = await identityFromToken(accessToken);
    if (identity === null) {
      return rejected("unauthenticated", [clearAuthCookie(), clearWorkspaceCookie()]);
    }

    const memberships: PublicDashboardMembership[] = await this.authDb.withClient((client) =>
      dashboardMembershipsByAuthUserId(client, identity.id),
    );
    if (memberships.length === 0) {
      return rejected("no_dashboard_membership", [setAuthCookie(accessToken), clearWorkspaceCookie()]);
    }

    const requestedWorkspace = selectedWorkspaceId ?? (memberships.length === 1 ? memberships[0]?.workspace_id : undefined);
    const cookies = [setAuthCookie(accessToken)];
    if (requestedWorkspace !== undefined) {
      const selected = await this.authDb.withWorkspace(requestedWorkspace, (client) =>
        dashboardMembershipByWorkspace(client, identity.id, requestedWorkspace),
      );
      if (selected === null) {
        return rejected("no_dashboard_membership", [setAuthCookie(accessToken), clearWorkspaceCookie()]);
      }
      cookies.push(setWorkspaceCookie(selected.workspace_id));
      return {
        envelope: {
          status: "ok",
          result: { memberships, selected_workspace_id: selected.workspace_id },
          warnings: [],
        },
        cookies,
      };
    }

    cookies.push(clearWorkspaceCookie());
    return {
      envelope: { status: "ok", result: { memberships, selected_workspace_id: null }, warnings: [] },
      cookies,
    };
  }

  async switchWorkspace(cookieHeaderValue: string | null, workspaceId: string): Promise<SessionResult> {
    const parsedWorkspace = workspaceIdInput.safeParse(workspaceId);
    if (!parsedWorkspace.success) {
      return rejected("validation_failed", [clearWorkspaceCookie()]);
    }
    const cookies = parseCookieHeader(cookieHeaderValue);
    if (cookies.accessToken === null) {
      return rejected("unauthenticated", [clearWorkspaceCookie()]);
    }
    return this.establish(cookies.accessToken, parsedWorkspace.data);
  }

  async acceptInvite(params: {
    accessToken: string;
    workspaceId: string;
    personId: string;
    requiredProvider?: "google";
  }): Promise<SessionResult> {
    const workspaceId = workspaceIdInput.safeParse(params.workspaceId);
    const personId = personIdInput.safeParse(params.personId);
    if (!workspaceId.success || !personId.success) {
      return rejected("validation_failed", [clearWorkspaceCookie()]);
    }
    const identity = await identityFromToken(params.accessToken);
    if (identity === null) {
      return rejected("unauthenticated", [clearAuthCookie(), clearWorkspaceCookie()]);
    }

    const acceptingEmail = params.requiredProvider === "google" ? googleIdentityEmail(identity) : identity.email;
    if (acceptingEmail === null) {
      return rejected("auth_email_mismatch", [setAuthCookie(params.accessToken), clearWorkspaceCookie()]);
    }

    const preflight = await this.authDb.withWorkspace(workspaceId.data, (client) =>
      preflightLinkAuthUserToPerson(client, {
        workspaceId: workspaceId.data,
        personId: personId.data,
        email: acceptingEmail,
        caseInsensitiveEmail: params.requiredProvider === "google",
      }),
    );
    if ("rejected" in preflight) {
      return rejected(preflight.rejected, [setAuthCookie(params.accessToken), clearWorkspaceCookie()]);
    }

    const envelope = await this.getKernel().dispatchInternal(
      { type: "system", workspaceId: workspaceId.data },
      {
        name: "person.link_auth",
        input: {
          person_id: personId.data,
          auth_user_id: identity.id,
          email: acceptingEmail,
          ...(params.requiredProvider === "google" ? { provider: "google" as const, email_verified: true } : {}),
        },
        idempotencyKey: `person.link:${personId.data}:${identity.id}`,
      },
    );
    if (envelope.status !== "ok") {
      return { envelope, cookies: [setAuthCookie(params.accessToken), clearWorkspaceCookie()] };
    }
    return this.establish(params.accessToken, workspaceId.data);
  }

  async resolveActor(cookieHeaderValue: string | null): Promise<ActorResolution> {
    const cookies = parseCookieHeader(cookieHeaderValue);
    if (cookies.accessToken === null || cookies.workspaceId === null) {
      return { actor: null, rejection: "unauthenticated", cookies: [] };
    }
    const identity = await identityFromToken(cookies.accessToken);
    if (identity === null) {
      return {
        actor: null,
        rejection: "unauthenticated",
        cookies: [clearAuthCookie(), clearWorkspaceCookie()],
      };
    }
    const workspaceId = workspaceIdInput.safeParse(cookies.workspaceId);
    if (!workspaceId.success) {
      return { actor: null, rejection: "unauthenticated", cookies: [clearWorkspaceCookie()] };
    }
    const membership = await this.authDb.withWorkspace(workspaceId.data, (client) =>
      dashboardMembershipByWorkspace(client, identity.id, workspaceId.data),
    );
    if (membership === null) {
      return {
        actor: null,
        rejection: "no_dashboard_membership",
        cookies: [clearWorkspaceCookie()],
      };
    }
    return { actor: actorForMembership(membership), membership, cookies: [] };
  }

  async currentSession(cookieHeaderValue: string | null): Promise<CurrentSession | null> {
    const resolved = await this.resolveActor(cookieHeaderValue);
    if (resolved.actor === null || resolved.actor.type !== "person" || resolved.membership === undefined) {
      return null;
    }
    return { actor: resolved.actor, membership: resolved.membership };
  }
}
