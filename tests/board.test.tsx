import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DayPackBoard, type BoardLabels } from "../app/(capture)/capture/day-pack-board";
import manifest from "../app/manifest";
import de from "../core/i18n/de.json";
import type { MeResponse } from "../core/reads/me";

const labels: BoardLabels = {
  title: de.board.title,
  eyebrow: de.board.eyebrow,
  workspace: de.board.workspace.replace("{workspace}", "Board GmbH"),
  offline: de.board.offline,
  updated: de.board.updated,
  noSites: de.board.no_sites,
  noWindows: de.board.no_windows,
  target: de.board.target,
  notApplicable: de.board.not_applicable,
  site: de.board.site,
  signOut: de.auth.sign_out,
  statuses: de.board.status,
};

const pack: MeResponse = {
  date: "2026-07-13",
  generated_at: "2026-07-13T06:00:00.000Z",
  sites: [
    {
      site_id: "00000000-0000-4000-8000-000000000001",
      name: "Alpha Standort",
      windows: [
        {
          window_id: "00000000-0000-4000-8000-000000000011",
          commitment_id: "00000000-0000-4000-8000-000000000021",
          title: "Frühschicht",
          type: "coverage",
          starts_at: "2026-07-13T04:00:00.000Z",
          ends_at: "2026-07-13T12:00:00.000Z",
          target_qty: 5,
          unit: null,
          requirements: { verification: { proof: { required: false } } },
          fulfillment: {
            rule: "coverage_max",
            target_qty: 5,
            unit: null,
            confirmed_headcount: 0,
            satisfied: false,
            counted_record_ids: [],
            computed_at: "2026-07-13T06:00:00.000Z",
          },
          status: "open",
          assignments: [],
        },
      ],
    },
    {
      site_id: "00000000-0000-4000-8000-000000000002",
      name: "Beta Standort",
      windows: [],
    },
  ],
  persons: [],
  labels: { title: "Erfassung" },
  person_id: "00000000-0000-4000-8000-000000000031",
  display_name: "Board Supervisor",
  role_class: "supervisor",
  workspace_id: "00000000-0000-4000-8000-000000000041",
  workspace_display_name: "Board GmbH",
};

describe("SLICE-015 Heute board", () => {
  it("renders catalog-labelled windows grouped by site without capture controls", () => {
    const html = renderToStaticMarkup(<DayPackBoard initialPack={pack} labels={labels} locale="de" />);
    expect(html).toContain(">Heute<");
    expect(html).toContain("Alpha Standort");
    expect(html).toContain("Frühschicht");
    expect(html).toContain(">Offen<");
    expect(html).toContain("Ziel: 5");
    expect(html).toContain("Beta Standort");
    expect(html).toContain("Heute keine Zeitfenster.");
    expect(html.indexOf("Alpha Standort")).toBeLessThan(html.indexOf("Beta Standort"));
    expect(html).toContain(`>${de.auth.sign_out}<`);
    expect(html).toContain("min-h-tap");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain("<form");
  });

  it("ships an optional-install manifest with icons and standalone display", () => {
    expect(manifest()).toMatchObject({
      name: de.app.title,
      short_name: de.app.short_name,
      start_url: "/capture",
      display: "standalone",
      icons: expect.arrayContaining([expect.objectContaining({ src: "/icon.svg" })]),
    });
  });

  it("ships shell and authenticated day-pack caching without an outbox", () => {
    const serviceWorker = readFileSync(join(process.cwd(), "public/sw.js"), "utf8");
    expect(serviceWorker).toContain('const CAPTURE_PATH = "/capture"');
    expect(serviceWorker).toContain('const DAY_PACK_PATH = "/api/reads/me"');
    expect(serviceWorker).toContain("DAY_PACK_CACHE");
    expect(serviceWorker).toContain("credentials: \"include\"");
    expect(serviceWorker).not.toContain("indexedDB");
    expect(serviceWorker).not.toContain('addEventListener("sync"');
  });
});
