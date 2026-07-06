import { handleActionsPost } from "@core/actions/http";
import { getKernel } from "@core/actions/runtime";

// §5: single action dispatch endpoint. Actor resolution attaches with auth
// (SLICE-008 manager sessions, SLICE-009 device tokens); until then every
// request resolves to no actor and receives the typed unauthenticated
// rejection — the kernel is never reached without an actor.
export async function POST(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const { httpStatus, envelope } = await handleActionsPost(getKernel, null, body);
  return Response.json(envelope, { status: httpStatus });
}
