"use client";

import { useEffect, useState } from "react";

import { Badge } from "@core/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@core/components/ui/card";
import type { MeResponse } from "@core/reads/me";

import { SignOutControl } from "../../sign-out-control";

type WindowStatus = MeResponse["sites"][number]["windows"][number]["status"];

export interface BoardLabels {
  title: string;
  eyebrow: string;
  workspace: string;
  offline: string;
  updated: string;
  noSites: string;
  noWindows: string;
  target: string;
  notApplicable: string;
  site: string;
  signOut: string;
  statuses: Record<WindowStatus, string>;
}

const statusStyles: Record<WindowStatus, string> = {
  scheduled: "bg-status-scheduled text-status-scheduled-foreground",
  open: "bg-status-open text-status-open-foreground",
  fulfilled: "bg-status-fulfilled text-status-fulfilled-foreground",
  shortfall: "bg-status-shortfall text-status-shortfall-foreground",
  missed: "bg-status-missed text-status-missed-foreground",
  closed: "bg-status-closed text-status-closed-foreground",
};

function wallClock(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function localDay(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function generatedAt(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function targetLabel(
  target: number | null,
  unit: string | null,
  locale: string,
  labels: BoardLabels,
): string {
  if (target === null) return `${labels.target}: ${labels.notApplicable}`;
  const quantity = new Intl.NumberFormat(locale).format(target);
  return `${labels.target}: ${quantity}${unit === null ? "" : ` ${unit}`}`;
}

export function DayPackBoard({
  initialPack,
  labels,
  locale,
}: {
  initialPack: MeResponse;
  labels: BoardLabels;
  locale: string;
}) {
  const [pack, setPack] = useState(initialPack);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = async (): Promise<void> => {
      try {
        const response = await fetch("/api/reads/me", {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!response.ok) throw new Error("day-pack refresh failed");
        const nextPack = (await response.json()) as MeResponse;
        if (active) {
          setPack(nextPack);
          setOffline(false);
        }
      } catch {
        if (active) setOffline(true);
      }
    };
    const onFocus = (): void => void refresh();
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") void refresh();
    };
    const onOnline = (): void => void refresh();
    const onOffline = (): void => setOffline(true);

    void refresh();
    const interval = window.setInterval(() => void refresh(), 60_000);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisibility);
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }

    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
      {offline ? (
        <div className="rounded-xl border-2 border-status-shortfall-foreground bg-status-shortfall px-4 py-3 font-semibold text-status-shortfall-foreground" role="status">
          {labels.offline}
        </div>
      ) : null}

      <header className="flex flex-col gap-2 border-b-2 border-foreground pb-5">
        <p className="text-sm font-bold tracking-[0.16em] text-muted-foreground uppercase">{labels.eyebrow}</p>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-board-title leading-none font-bold tracking-tight">{labels.title}</h1>
            <p className="mt-2 text-lg font-semibold capitalize">{localDay(pack.date, locale)}</p>
          </div>
          <div className="flex items-center gap-3">
            <p className="text-sm font-medium text-muted-foreground">{labels.workspace}</p>
            <SignOutControl label={labels.signOut} />
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          {`${labels.updated}: `}<time dateTime={pack.generated_at}>{generatedAt(pack.generated_at, locale)}</time>
        </p>
      </header>

      {pack.sites.length === 0 ? (
        <Card className="border-2 border-dashed bg-muted/40 py-10 text-center shadow-none">
          <CardContent className="text-lg font-semibold">{labels.noSites}</CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-7">
          {pack.sites.map((site) => (
            <section key={site.site_id} aria-label={`${labels.site}: ${site.name}`} className="flex flex-col gap-3">
              <h2 className="text-site-title font-bold tracking-tight">{site.name}</h2>
              {site.windows.length === 0 ? (
                <Card className="border-dashed bg-muted/30 shadow-none">
                  <CardContent className="text-base font-medium text-muted-foreground">{labels.noWindows}</CardContent>
                </Card>
              ) : (
                <div className="grid gap-3">
                  {site.windows.map((window) => (
                    <Card key={window.window_id} data-status={window.status} className="min-h-tap border-2 shadow-sm">
                      <CardHeader className="grid grid-cols-[1fr_auto] gap-4">
                        <div className="min-w-0">
                          <CardTitle className="text-window-title font-bold">{window.title}</CardTitle>
                          <p className="mt-1 text-base font-semibold tabular-nums">
                            {`${wallClock(window.starts_at, locale)}–${wallClock(window.ends_at, locale)}`}
                          </p>
                        </div>
                        <Badge className={statusStyles[window.status]}>{labels.statuses[window.status]}</Badge>
                      </CardHeader>
                      <CardContent>
                        <p className="text-base font-semibold tabular-nums">
                          {targetLabel(window.target_qty, window.unit, locale, labels)}
                        </p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
