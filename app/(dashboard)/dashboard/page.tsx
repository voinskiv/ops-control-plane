import { getDashboardAuth } from "@core/auth/runtime";
import { dashboardAccess } from "@core/auth/surface";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { forbidden, redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await getDashboardAuth().currentSession((await cookies()).toString());
  if (session === null) {
    redirect("/login");
  }
  if (!dashboardAccess(session.actor.roleClass).allowed) {
    forbidden();
  }
  const t = await getTranslations();
  return (
    <main>
      <h1>{t("app.title")}</h1>
      <p>{t("auth.shell.workspace", { workspace: session.membership.workspace_display_name })}</p>
      <p>{t(`auth.role.${session.actor.roleClass}`)}</p>
    </main>
  );
}
