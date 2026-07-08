import { getDashboardAuth } from "@core/auth/runtime";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

export default async function Home() {
  const t = await getTranslations();
  const cookieHeader = (await cookies()).toString();
  const session = await getDashboardAuth().currentSession(cookieHeader);
  if (session === null) {
    redirect("/login");
  }

  return (
    <main>
      <h1>{t("app.title")}</h1>
      <p>{t("auth.shell.workspace", { workspace: session.membership.workspace_display_name })}</p>
      <p>{t(`auth.role.${session.actor.roleClass}`)}</p>
    </main>
  );
}
