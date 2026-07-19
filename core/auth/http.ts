import { z } from "zod";

import type { DashboardAuth, SessionResult } from "./session";
import { cookieHeader, GOOGLE_INVITE_STATE_COOKIE } from "./session";
import { appOrigin } from "./transport";
import type { ResponseEnvelope } from "../actions/types";

const tokenBody = z
  .object({
    access_token: z.string().min(1).max(8192),
    workspace_id: z.uuid().optional(),
  })
  .strict();

const workspaceBody = z
  .object({
    workspace_id: z.uuid(),
  })
  .strict();

const acceptBody = z
  .object({
    access_token: z.string().min(1).max(8192),
    workspace_id: z.uuid(),
    person_id: z.uuid(),
  })
  .strict();

const googleAcceptBody = z
  .object({
    access_token: z.string().min(1).max(8192),
    state: z.uuid(),
  })
  .strict();

function statusFor(envelope: ResponseEnvelope): number {
  if (envelope.status === "ok") {
    return 200;
  }
  const code = (envelope.result as { code?: string } | null)?.code;
  if (code === "unauthenticated") {
    return 401;
  }
  if (code === "no_dashboard_membership" || code === "auth_email_mismatch") {
    return 403;
  }
  if (code === "auth_already_linked") {
    return 409;
  }
  return 400;
}

function responseFromSession(result: SessionResult): Response {
  const response = Response.json(result.envelope, { status: statusFor(result.envelope) });
  for (const cookie of result.cookies) {
    response.headers.append("set-cookie", cookieHeader(cookie));
  }
  return response;
}

async function jsonBody(request: Request): Promise<unknown> {
  return request.json().catch(() => null);
}

function requestCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  return null;
}

export async function handleMagicLinkPost(auth: DashboardAuth, request: Request): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const email = form?.get("email");
  const envelope = await auth.sendMagicLink(typeof email === "string" ? email : "");
  if (envelope.status !== "ok") {
    return Response.json(envelope, { status: statusFor(envelope) });
  }
  return new Response(null, { status: 303, headers: { Location: "/login?sent=1" } });
}

export function handleGoogleSignInGet(auth: DashboardAuth, request: Request): Response {
  void request;
  return Response.redirect(auth.startGoogleSignIn(appOrigin()), 303);
}

export async function handleGoogleInvitePost(auth: DashboardAuth, request: Request): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const workspaceId = form?.get("workspace_id");
  const personId = form?.get("person_id");
  const started = auth.startGoogleInvite(
    appOrigin(),
    typeof workspaceId === "string" ? workspaceId : "",
    typeof personId === "string" ? personId : "",
  );
  if (started === null) {
    return Response.json(
      { status: "rejected", result: { code: "validation_failed" }, warnings: [] },
      { status: 400 },
    );
  }
  const response = new Response(null, { status: 303, headers: { Location: started.location } });
  for (const cookie of started.cookies) {
    response.headers.append("set-cookie", cookieHeader(cookie));
  }
  return response;
}

export async function handleGoogleInviteAcceptPost(auth: DashboardAuth, request: Request): Promise<Response> {
  const parsed = googleAcceptBody.safeParse(await jsonBody(request));
  if (!parsed.success) {
    return Response.json(
      { status: "rejected", result: { code: "validation_failed" }, warnings: [] },
      { status: 400 },
    );
  }
  return responseFromSession(
    await auth.completeGoogleInvite({
      accessToken: parsed.data.access_token,
      state: parsed.data.state,
      stateCookie: requestCookie(request, GOOGLE_INVITE_STATE_COOKIE),
    }),
  );
}

export async function handleSessionPost(auth: DashboardAuth, request: Request): Promise<Response> {
  const parsed = tokenBody.safeParse(await jsonBody(request));
  if (!parsed.success) {
    return Response.json({ status: "rejected", result: { code: "validation_failed" }, warnings: [] }, { status: 400 });
  }
  return responseFromSession(await auth.establish(parsed.data.access_token, parsed.data.workspace_id));
}

export async function handleWorkspacePost(auth: DashboardAuth, request: Request): Promise<Response> {
  const parsed = workspaceBody.safeParse(await jsonBody(request));
  if (!parsed.success) {
    return Response.json({ status: "rejected", result: { code: "validation_failed" }, warnings: [] }, { status: 400 });
  }
  return responseFromSession(await auth.switchWorkspace(request.headers.get("cookie"), parsed.data.workspace_id));
}

export async function handleSignOutPost(auth: DashboardAuth, request: Request): Promise<Response> {
  return responseFromSession(await auth.signOut(request.headers.get("cookie")));
}

export async function handleAcceptPost(auth: DashboardAuth, request: Request): Promise<Response> {
  const parsed = acceptBody.safeParse(await jsonBody(request));
  if (!parsed.success) {
    return Response.json({ status: "rejected", result: { code: "validation_failed" }, warnings: [] }, { status: 400 });
  }
  return responseFromSession(
    await auth.acceptInvite({
      accessToken: parsed.data.access_token,
      workspaceId: parsed.data.workspace_id,
      personId: parsed.data.person_id,
    }),
  );
}
