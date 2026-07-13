import { getDashboardAuth } from "@core/auth/runtime";
import { dashboardAccess } from "@core/auth/surface";
import { commitmentWeekdays } from "@core/domain/commitment-rrule-presets";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { forbidden, redirect } from "next/navigation";

import { CommitmentDraftForm } from "./commitment-draft-form";
import { CommitmentManageForm } from "./commitment-manage-form";
import type { CommitmentFormLabels } from "./form-labels";

export const dynamic = "force-dynamic";

export default async function CommitmentsPage() {
  const session = await getDashboardAuth().currentSession((await cookies()).toString());
  if (session === null) redirect("/login");
  if (!dashboardAccess(session.actor.roleClass).allowed) forbidden();
  const t = await getTranslations();
  const errors = [
    "validation_failed",
    "unauthorized",
    "commitment_wrong_state",
    "commitment_patch_forbidden",
    "commitment_site_inactive",
    "commitment_has_open_windows",
  ];
  const labels: CommitmentFormLabels = {
    draftTitle: t("commitments.draft_title"), manageTitle: t("commitments.manage_title"),
    siteId: t("commitments.site_id"), commitmentId: t("commitments.commitment_id"), type: t("commitments.type"),
    types: { coverage: t("commitments.type_coverage"), output: t("commitments.type_output"), service_scope: t("commitments.type_service_scope") },
    title: t("commitments.title"), windowStart: t("commitments.window_start"), windowEnd: t("commitments.window_end"),
    schedule: t("commitments.schedule"),
    schedules: { daily: t("commitments.schedule_daily"), weekdays: t("commitments.schedule_weekdays"), weekly: t("commitments.schedule_weekly"), biweekly: t("commitments.schedule_biweekly") },
    selectedDays: t("commitments.selected_days"),
    weekdays: Object.fromEntries(commitmentWeekdays.map((day) => [day, t(`commitments.weekday_${day.toLowerCase()}`)])) as CommitmentFormLabels["weekdays"],
    targetQty: t("commitments.target_qty"), unit: t("commitments.unit"), checklistKey: t("commitments.checklist_key"), checklistLabel: t("commitments.checklist_label"),
    validFrom: t("commitments.valid_from"), validTo: t("commitments.valid_to"), create: t("commitments.create"), update: t("commitments.update"), updateTitle: t("commitments.update_title"),
    action: t("commitments.action"), actions: { activate: t("commitments.action_activate"), pause: t("commitments.action_pause"), complete: t("commitments.action_complete"), archive: t("commitments.action_archive") },
    reason: t("commitments.reason"), applyAction: t("commitments.apply_action"), success: t("commitments.success"), failed: t("commitments.failed"),
    errors: Object.fromEntries(errors.map((code) => [code, t(`errors.action.${code}`)])),
  };
  return <main><h1>{t("commitments.page_title")}</h1><CommitmentDraftForm labels={labels} /><CommitmentManageForm labels={labels} /></main>;
}
