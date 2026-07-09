import { z } from "zod";

import type { DashboardAuth, SessionResult } from "./session";
import { cookieHeader } from "./session";
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

export async function handleMagicLinkPost(auth: DashboardAuth, request: Request): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const email = form?.get("email");
  const envelope = await auth.sendMagicLink(typeof email === "string" ? email : "");
  if (envelope.status !== "ok") {
    return Response.json(envelope, { status: statusFor(envelope) });
  }
  return Response.redirect(new URL("/login?sent=1", request.url), 303);
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
