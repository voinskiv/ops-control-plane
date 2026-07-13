import { getDashboardAuth } from "@core/auth/runtime";
import { captureAllowed } from "@core/auth/surface";
import { meResponseSchema } from "@core/reads/me";
import { getReads } from "@core/reads/runtime";
import { cookies } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";
import { forbidden, redirect } from "next/navigation";

import { DayPackBoard, type BoardLabels } from "./day-pack-board";

export const dynamic = "force-dynamic";

export default async function CapturePage() {
  const session = await getDashboardAuth().currentSession((await cookies()).toString());
  if (session === null) {
    redirect("/login");
  }
  if (!captureAllowed(session.actor.roleClass)) {
    forbidden();
  }
  const [t, locale, read] = await Promise.all([
    getTranslations(),
    getLocale(),
    getReads().dispatch(session.actor, "me", {}),
  ]);
  if (!read.ok) throw new Error("authenticated me read failed");
  const labels: BoardLabels = {
    title: t("board.title"),
    eyebrow: t("board.eyebrow"),
    workspace: t("board.workspace", { workspace: session.membership.workspace_display_name }),
    offline: t("board.offline"),
    updated: t("board.updated"),
    noSites: t("board.no_sites"),
    noWindows: t("board.no_windows"),
    target: t("board.target"),
    notApplicable: t("board.not_applicable"),
    site: t("board.site"),
    statuses: {
      scheduled: t("board.status.scheduled"),
      open: t("board.status.open"),
      fulfilled: t("board.status.fulfilled"),
      shortfall: t("board.status.shortfall"),
      missed: t("board.status.missed"),
      closed: t("board.status.closed"),
    },
  };
  return <DayPackBoard initialPack={meResponseSchema.parse(read.data)} labels={labels} locale={locale} />;
}
