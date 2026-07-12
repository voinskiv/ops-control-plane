import { getTranslations } from "next-intl/server";

import { InviteEmailAcceptance } from "../invite-email-acceptance";

export default async function InviteAcceptPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace_id?: string; person_id?: string }>;
}) {
  const t = await getTranslations();
  const params = await searchParams;
  const workspaceId = params.workspace_id ?? "";
  const personId = params.person_id ?? "";
  return (
    <main>
      <h1>{t("auth.accept.title")}</h1>
      <InviteEmailAcceptance
        workspaceId={workspaceId}
        personId={personId}
        label={t("auth.accept.email")}
        failedLabel={t("auth.callback.failed")}
      />
      <form action="/api/auth/google/invite" method="post">
        <input type="hidden" name="workspace_id" value={workspaceId} />
        <input type="hidden" name="person_id" value={personId} />
        <button type="submit">{t("auth.accept.google")}</button>
      </form>
    </main>
  );
}
