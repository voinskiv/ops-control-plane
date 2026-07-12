import { getDashboardAuth } from "@core/auth/runtime";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { landingRoute } from "@core/auth/surface";

export const dynamic = "force-dynamic";

export default async function Home() {
  const cookieHeader = (await cookies()).toString();
  const session = await getDashboardAuth().currentSession(cookieHeader);
  if (session === null) {
    redirect("/login");
  }

  redirect(landingRoute(session.actor.roleClass));
}
