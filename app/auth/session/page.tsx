import { getTranslations } from "next-intl/server";

import { AuthCallback } from "../auth-callback";

export default async function AuthSessionPage() {
  const t = await getTranslations();
  return <AuthCallback endpoint="/api/auth/session" failedLabel={t("auth.callback.failed")} />;
}
