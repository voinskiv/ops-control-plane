import { z } from "zod";

import de from "../i18n/de.json";
import en from "../i18n/en.json";
import { meIdentityRow } from "../db/reads";
import type { ReadDefinition } from "./types";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const timestampSchema = z.iso.datetime();
const uuidSchema = z.uuid();

const verificationSchema = z
  .object({
    proof: z
      .object({
        required: z.boolean(),
        types: z.array(z.enum(["photo", "signature"])),
        min_count: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

const checklistItemSchema = z.object({ key: z.string(), label: z.string() }).strict();
const requirementsSchema = z
  .object({
    verification: verificationSchema,
    checklist: z.array(checklistItemSchema).optional(),
  })
  .strict();

const fulfillmentSchema = z
  .object({
    rule: z.string(),
    target_qty: z.number().nullable(),
    unit: z.string().nullable(),
    verified_qty: z.number().optional(),
    confirmed_headcount: z.number().int().nonnegative().optional(),
    checklist_state: z.array(z.object({ key: z.string(), done: z.boolean() }).strict()).optional(),
    satisfied: z.boolean(),
    counted_record_ids: z.array(uuidSchema),
    computed_at: timestampSchema,
  })
  .strict();

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
    const result: MeResponse = {
      date: localDate(ctx.now, workspaceTimeZone(identity.workspace_settings)),
      generated_at: ctx.now.toISOString(),
      sites: [],
      persons: [],
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
