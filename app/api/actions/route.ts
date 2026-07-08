import { handleActionsPost } from "@core/actions/http";
import { getKernel } from "@core/actions/runtime";
import { cookieHeader } from "@core/auth/session";
import { getDashboardAuth } from "@core/auth/runtime";

// §5: single action dispatch endpoint. SLICE-008 attaches manager person
// actor resolution; SLICE-009 adds device-token supervisors.
export async function POST(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const resolved = await getDashboardAuth().resolveActor(request.headers.get("cookie"));
  const { httpStatus, envelope } = await handleActionsPost(getKernel, resolved.actor, body);
  const response = Response.json(envelope, { status: httpStatus });
  for (const cookie of resolved.cookies) {
    response.headers.append("set-cookie", cookieHeader(cookie));
  }
  return response;
}
