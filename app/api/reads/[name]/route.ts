import { cookieHeader } from "@core/auth/session";
import { getDashboardAuth } from "@core/auth/runtime";
import { handleReadsGet } from "@core/reads/http";
import { getReads } from "@core/reads/runtime";

interface RouteContext {
  params: Promise<{ name: string }>;
}

// §5 / §19: thin GET /api/reads/:name mount; all resolution, validation,
// authorization, RLS-scoped query logic, and response validation live in core.
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const [{ name }, resolved] = await Promise.all([
    context.params,
    getDashboardAuth().resolveActor(request.headers.get("cookie")),
  ]);
  const query = Object.fromEntries(new URL(request.url).searchParams.entries());
  const { httpStatus, body } = await handleReadsGet(getReads(), resolved, name, query);
  const response = Response.json(body, { status: httpStatus });
  for (const cookie of resolved.cookies) {
    response.headers.append("set-cookie", cookieHeader(cookie));
  }
  return response;
}
