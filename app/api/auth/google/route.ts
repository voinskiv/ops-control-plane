import { handleGoogleSignInGet } from "@core/auth/http";
import { getDashboardAuth } from "@core/auth/runtime";

export function GET(request: Request): Response {
  return handleGoogleSignInGet(getDashboardAuth(), request);
}
