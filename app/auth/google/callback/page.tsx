import { getTranslations } from "next-intl/server";

import { AuthCallback } from "../../auth-callback";

export default async function GoogleCallbackPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const t = await getTranslations();
  const state = (await searchParams).state ?? "";
  return <AuthCallback endpoint="/api/auth/google/accept" state={state} failedLabel={t("auth.callback.failed")} />;
}
