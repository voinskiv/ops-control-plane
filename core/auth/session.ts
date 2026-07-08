import { z } from "zod";

import type { Kernel } from "../actions/kernel";
import { envelopeRejected, type Actor, type RejectionCode, type ResponseEnvelope } from "../actions/types";
import type { AuthDb } from "../db/auth";
import {
  dashboardMembershipByWorkspace,
  dashboardMembershipsByAuthUserId,
  type DashboardMembership,
} from "../db/persons";
import { getAuthTransport, type AuthIdentity } from "./transport";

export const AUTH_TOKEN_COOKIE = "ocp_auth_token";
export const WORKSPACE_COOKIE = "ocp_workspace_id";

const accessTokenInput = z.string().min(1).max(8192);
const workspaceIdInput = z.uuid();
const personIdInput = z.uuid();
const emailInput = z.string().trim().max(254);

export interface CookieChange {
  name: typeof AUTH_TOKEN_COOKIE | typeof WORKSPACE_COOKIE;
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

  async establish(accessToken: string, selectedWorkspaceId?: string): Promise<SessionResult> {
    const identity = await identityFromToken(accessToken);
    if (identity === null) {
      return rejected("unauthenticated", [clearAuthCookie(), clearWorkspaceCookie()]);
    }

    const memberships = await this.authDb.withClient((client) => dashboardMembershipsByAuthUserId(client, identity.id));
    if (memberships.length === 0) {
      return rejected("no_dashboard_membership", [setAuthCookie(accessToken), clearWorkspaceCookie()]);
    }

    const requestedWorkspace = selectedWorkspaceId ?? (memberships.length === 1 ? memberships[0]?.workspace_id : undefined);
    const cookies = [setAuthCookie(accessToken)];
    if (requestedWorkspace !== undefined) {
      const selected = memberships.find((membership) => membership.workspace_id === requestedWorkspace);
      if (selected === undefined) {
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

    const envelope = await this.getKernel().dispatchInternal(
      { type: "system", workspaceId: workspaceId.data },
      {
        name: "person.link_auth",
        input: { person_id: personId.data, auth_user_id: identity.id, email: identity.email },
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
      return { actor: null, cookies: [] };
    }
    const identity = await identityFromToken(cookies.accessToken);
    if (identity === null) {
      return { actor: null, cookies: [clearAuthCookie(), clearWorkspaceCookie()] };
    }
    const membership = await this.authDb.withClient((client) =>
      dashboardMembershipByWorkspace(client, identity.id, cookies.workspaceId ?? ""),
    );
    if (membership === null) {
      return { actor: null, cookies: [clearWorkspaceCookie()] };
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
