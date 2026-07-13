import { z } from "zod";

import de from "../i18n/de.json";
import en from "../i18n/en.json";
import { verificationSchema } from "../domain/commitment-types";
import { meDayPackRows, meIdentityRow, type MeDayPackRow } from "../db/reads";
import type { ReadDefinition } from "./types";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const timestampSchema = z.iso.datetime();
const uuidSchema = z.uuid();

const checklistItemSchema = z.object({ key: z.string(), label: z.string() }).strict();
const requirementsSchema = z
  .object({
    verification: verificationSchema,
    checklist: z.array(checklistItemSchema).optional(),
  })
  .strict();

const fulfillmentBaseShape = {
    rule: z.string(),
    target_qty: z.number().nullable(),
    unit: z.string().nullable(),
    satisfied: z.boolean(),
    counted_record_ids: z.array(uuidSchema),
    computed_at: timestampSchema,
};

const checklistStateItemSchema = z
  .object({ key: z.string(), done: z.boolean(), note: z.string().optional() })
  .strict();
const fulfillmentSchema = z.discriminatedUnion("rule", [
  z.object({ ...fulfillmentBaseShape, rule: z.literal("coverage_max"), confirmed_headcount: z.number().int().nonnegative() }).strict(),
  z.object({ ...fulfillmentBaseShape, rule: z.literal("output_sum"), verified_qty: z.number() }).strict(),
  z.object({
    ...fulfillmentBaseShape,
    rule: z.literal("checklist_completion"),
    checklist_state: z.object({ items: z.array(checklistStateItemSchema) }).strict(),
  }).strict(),
]);

const assignmentSchema = z
  .object({
    person_id: uuidSchema,
    display_name: z.string(),
    status: z.enum(["planned", "confirmed", "removed"]),
  })
  .strict();

const windowSchema = z
  .object({
    window_id: uuidSchema,
    commitment_id: uuidSchema,
    title: z.string(),
    type: z.enum(["coverage", "output", "service_scope"]),
    starts_at: timestampSchema,
    ends_at: timestampSchema,
    target_qty: z.number().nullable(),
    unit: z.string().nullable(),
    requirements: requirementsSchema,
    fulfillment: fulfillmentSchema,
    status: z.enum(["scheduled", "open", "fulfilled", "shortfall", "missed", "closed"]),
    assignments: z.array(assignmentSchema),
  })
  .strict();

const siteSchema = z
  .object({
    site_id: uuidSchema,
    name: z.string(),
    windows: z.array(windowSchema),
  })
  .strict();

const personSchema = z
  .object({
    person_id: uuidSchema,
    display_name: z.string(),
    role_class: z.enum(["owner", "manager", "supervisor", "worker"]),
  })
  .strict();

export const meParamsSchema = z.object({}).strict();

// DEC-016 item 8: the Phase 0 shell keeps the canonical day-pack schema so
// SLICE-015 populates sites/persons without replacing this public read shape.
// The identity fields are the operator-authorized F29 deviation for SLICE-010.
export const meResponseSchema = z
  .object({
    date: dateSchema,
    generated_at: timestampSchema,
    sites: z.array(siteSchema),
    persons: z.array(personSchema),
    labels: z.record(z.string(), z.string()),
    person_id: uuidSchema,
    display_name: z.string(),
    role_class: z.enum(["owner", "manager", "supervisor"]),
    workspace_id: uuidSchema,
    workspace_display_name: z.string(),
  })
  .strict();

export type MeResponse = z.infer<typeof meResponseSchema>;

function workspaceTimeZone(settings: unknown): string {
  if (typeof settings !== "object" || settings === null || !("tz" in settings)) {
    throw new Error("workspace timezone is missing");
  }
  const timeZone = (settings as { tz?: unknown }).tz;
  if (typeof timeZone !== "string" || timeZone.length === 0) {
    throw new Error("workspace timezone is invalid");
  }
  return timeZone;
}

function localDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function captureLabels(locale: string): Record<string, string> {
  return locale === "en" ? en.capture : de.capture;
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function dayPack(rows: MeDayPackRow[]): Pick<MeResponse, "sites" | "persons"> {
  const sites: MeResponse["sites"] = [];
  const siteById = new Map<string, MeResponse["sites"][number]>();
  const windowById = new Map<string, MeResponse["sites"][number]["windows"][number]>();
  const personById = new Map<string, MeResponse["persons"][number]>();

  for (const row of rows) {
    let site = siteById.get(row.site_id);
    if (site === undefined) {
      site = { site_id: row.site_id, name: row.site_name, windows: [] };
      siteById.set(row.site_id, site);
      sites.push(site);
    }
    if (
      row.window_id === null || row.commitment_id === null || row.title === null || row.type === null ||
      row.starts_at === null || row.ends_at === null || row.requirements === null || row.fulfillment === null ||
      row.window_status === null
    ) {
      continue;
    }

    let window = windowById.get(row.window_id);
    if (window === undefined) {
      window = {
        window_id: row.window_id,
        commitment_id: row.commitment_id,
        title: row.title,
        type: row.type,
        starts_at: timestamp(row.starts_at),
        ends_at: timestamp(row.ends_at),
        target_qty: row.target_qty === null ? null : Number(row.target_qty),
        unit: row.unit,
        requirements: row.requirements as MeResponse["sites"][number]["windows"][number]["requirements"],
        fulfillment: row.fulfillment as MeResponse["sites"][number]["windows"][number]["fulfillment"],
        status: row.window_status,
        assignments: [],
      };
      windowById.set(row.window_id, window);
      site.windows.push(window);
    }

    if (
      row.assignment_person_id !== null && row.assignment_display_name !== null &&
      row.assignment_status !== null && row.assignment_role_class !== null
    ) {
      window.assignments.push({
        person_id: row.assignment_person_id,
        display_name: row.assignment_display_name,
        status: row.assignment_status,
      });
      personById.set(row.assignment_person_id, {
        person_id: row.assignment_person_id,
        display_name: row.assignment_display_name,
        role_class: row.assignment_role_class,
      });
    }
  }

  return {
    sites,
    persons: [...personById.values()].sort(
      (left, right) => left.display_name.localeCompare(right.display_name) || left.person_id.localeCompare(right.person_id),
    ),
  };
}

export const meRead: ReadDefinition<Record<string, never>, MeResponse> = {
  name: "me",
  actors: ["owner", "manager", "supervisor"],
  params: meParamsSchema,
  response: meResponseSchema,
  async execute(ctx) {
    const identity = await meIdentityRow(ctx.tx, ctx.actor.id, ctx.actor.workspaceId);
    if (identity === null) {
      return { rejected: "no_dashboard_membership" };
    }
    const date = localDate(ctx.now, workspaceTimeZone(identity.workspace_settings));
    const pack = dayPack(
      await meDayPackRows(ctx.tx, identity.workspace_id, date, identity.role_class, identity.person_id),
    );
    const result: MeResponse = {
      date,
      generated_at: ctx.now.toISOString(),
      sites: pack.sites,
      persons: pack.persons,
      labels: captureLabels(identity.locale),
      person_id: identity.person_id,
      display_name: identity.display_name,
      role_class: identity.role_class,
      workspace_id: identity.workspace_id,
      workspace_display_name: identity.workspace_display_name,
    };
    return { result };
  },
};
