import { getDashboardAuth } from "@core/auth/runtime";
import { captureAllowed } from "@core/auth/surface";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { forbidden, redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function CapturePage() {
  const session = await getDashboardAuth().currentSession((await cookies()).toString());
  if (session === null) {
    redirect("/login");
  }
  if (!captureAllowed(session.actor.roleClass)) {
    forbidden();
  }
  const t = await getTranslations();
  return (
    <main>
      <h1>{t("auth.capture.title")}</h1>
      <p>{t("auth.shell.workspace", { workspace: session.membership.workspace_display_name })}</p>
      <p>{t(`auth.role.${session.actor.roleClass}`)}</p>
    </main>
  );
}
