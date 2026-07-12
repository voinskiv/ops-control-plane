import { DASHBOARD_REJECTION_CODE } from "@core/auth/surface";
import { getTranslations } from "next-intl/server";

export default async function DashboardForbidden() {
  const t = await getTranslations();
  return (
    <main>
      <h1>{t("auth.forbidden.title")}</h1>
      <p>{t("errors.action.unauthorized")}</p>
      <p>{t("auth.forbidden.code", { code: DASHBOARD_REJECTION_CODE })}</p>
    </main>
  );
}
