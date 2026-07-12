import { handleGoogleInviteAcceptPost } from "@core/auth/http";
import { getDashboardAuth } from "@core/auth/runtime";

export async function POST(request: Request): Promise<Response> {
  return handleGoogleInviteAcceptPost(getDashboardAuth(), request);
}
