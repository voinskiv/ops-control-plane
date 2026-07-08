// Drizzle mirror of the 22 ARCHITECTURE.md §3 tables. Migrations remain the
// source that creates the database; this mirror is for typed domain CRUD and is
// kept honest by the schema-parity test.
import { getTableColumns, getTableName } from "drizzle-orm";
import { boolean, customType, date, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => timestamptz("created_at").defaultNow().notNull();
const daterange = customType<{ data: string; driverData: string }>({
  dataType: () => "daterange",
});

export const workspaceStatus = pgEnum("workspace_status", ["active", "suspended"]);
export const roleClass = pgEnum("role_class", ["owner", "manager", "supervisor", "worker"]);
export const personStatus = pgEnum("person_status", ["active", "inactive", "pseudonymized"]);
export const deviceStatus = pgEnum("device_status", ["pending", "active", "revoked"]);
export const clientStatus = pgEnum("client_status", ["active", "archived"]);
// DEC-009: 'draft' is non-billable — site.create writes it; site.activate is
// the sole transition onto 'active' (the §9 meter-moving event).
export const siteStatus = pgEnum("site_status", ["draft", "active", "archived"]);
export const commitmentType = pgEnum("commitment_type", ["coverage", "output", "service_scope", "proof", "recovery"]);
export const commitmentStatus = pgEnum("commitment_status", ["draft", "active", "paused", "completed", "archived"]);
export const windowStatus = pgEnum("window_status", ["scheduled", "open", "fulfilled", "shortfall", "missed", "closed"]);
export const assignmentStatus = pgEnum("assignment_status", ["planned", "confirmed", "removed"]);
export const recordKind = pgEnum("record_kind", ["presence", "coverage_confirm", "output", "service_confirmation", "note"]);
export const recordStatus = pgEnum("record_status", ["recorded", "verified", "superseded", "voided"]);
export const proofType = pgEnum("proof_type", ["photo", "signature", "checklist", "note"]);
export const proofStatus = pgEnum("proof_status", ["pending_upload", "complete", "failed"]);
export const exceptionType = pgEnum("exception_type", [
  "no_show",
  "under_coverage",
  "output_shortfall",
  "missing_proof",
  "client_complaint",
  "other",
]);
export const exceptionStatus = pgEnum("exception_status", ["open", "owned", "recovering", "resolved", "closed", "cancelled"]);
export const escalationScope = pgEnum("escalation_scope", ["workspace", "client", "site", "commitment_type"]);
export const escalationRuleStatus = pgEnum("escalation_rule_status", ["active", "disabled"]);
export const recoveryStatus = pgEnum("recovery_status", ["proposed", "approved", "in_progress", "done", "cancelled"]);
export const reportType = pgEnum("report_type", ["leistungsnachweis", "csv_export", "digest"]);
export const reportStatus = pgEnum("report_status", ["generating", "ready", "failed", "superseded"]);
export const shareStatus = pgEnum("share_status", ["active", "revoked", "expired"]);
export const proposalStatus = pgEnum("proposal_status", ["proposed", "approved", "rejected", "expired", "superseded"]);
export const documentKind = pgEnum("document_kind", ["order", "einsatzvereinbarung", "scope", "other"]);
export const documentStatus = pgEnum("document_status", ["uploaded", "extracted", "failed"]);
export const invocationStatus = pgEnum("invocation_status", ["pending", "ok", "rejected", "error"]);
export const invocationActorType = pgEnum("invocation_actor_type", ["person", "agent", "system", "platform"]);
export const actorType = pgEnum("actor_type", ["person", "agent", "system", "platform"]);
export const messageChannel = pgEnum("message_channel", ["email", "webpush", "whatsapp", "teams"]);
export const messageStatus = pgEnum("message_status", ["queued", "sent", "failed", "blocked"]);

export const plans = pgTable("plans", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  limits: jsonb("limits").notNull(),
  price: jsonb("price").notNull(),
  createdAt: createdAt(),
});

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  planCode: text("plan_code").notNull(),
  settings: jsonb("settings").notNull(),
  status: workspaceStatus("status").notNull(),
  createdAt: createdAt(),
});

export const persons = pgTable("persons", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  displayName: text("display_name").notNull(),
  roleClass: roleClass("role_class").notNull(),
  authUserId: uuid("auth_user_id"),
  email: text("email"),
  phone: text("phone"),
  locale: text("locale").notNull(),
  pinHash: text("pin_hash"),
  status: personStatus("status").notNull(),
  createdAt: createdAt(),
});

export const authDevices = pgTable("auth_devices", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  personId: uuid("person_id").notNull(),
  label: text("label").notNull(),
  tokenHash: text("token_hash").notNull(),
  enrolledBy: uuid("enrolled_by").notNull(),
  lastSeenAt: timestamptz("last_seen_at"),
  status: deviceStatus("status").notNull(),
  createdAt: createdAt(),
});

export const clients = pgTable("clients", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  contact: jsonb("contact").notNull(),
  status: clientStatus("status").notNull(),
  createdAt: createdAt(),
});

export const sites = pgTable("sites", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  clientId: uuid("client_id").notNull(),
  name: text("name").notNull(),
  address: jsonb("address").notNull(),
  settings: jsonb("settings").notNull(),
  status: siteStatus("status").notNull(),
  createdAt: createdAt(),
});

export const commitments = pgTable("commitments", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  clientId: uuid("client_id").notNull(),
  siteId: uuid("site_id").notNull(),
  type: commitmentType("type").notNull(),
  title: text("title").notNull(),
  spec: jsonb("spec").notNull(),
  scheduleRrule: text("schedule_rrule").notNull(),
  targetQty: numeric("target_qty"),
  unit: text("unit"),
  verification: jsonb("verification").notNull(),
  validFrom: date("valid_from").notNull(),
  validTo: date("valid_to").notNull(),
  status: commitmentStatus("status").notNull(),
  createdAt: createdAt(),
});

export const reports = pgTable("reports", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  clientId: uuid("client_id"),
  type: reportType("type").notNull(),
  params: jsonb("params").notNull(),
  period: daterange("period").notNull(),
  snapshotPath: text("snapshot_path").notNull(),
  version: integer("version").notNull(),
  generatedByActor: jsonb("generated_by_actor").notNull(),
  status: reportStatus("status").notNull(),
  createdAt: createdAt(),
});

export const executionWindows = pgTable("execution_windows", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  commitmentId: uuid("commitment_id").notNull(),
  siteId: uuid("site_id").notNull(),
  date: date("date").notNull(),
  startsAt: timestamptz("starts_at").notNull(),
  endsAt: timestamptz("ends_at").notNull(),
  targetQty: numeric("target_qty"),
  unit: text("unit"),
  requirements: jsonb("requirements").notNull(),
  fulfillment: jsonb("fulfillment").notNull(),
  closedBy: uuid("closed_by"),
  closedAt: timestamptz("closed_at"),
  reportId: uuid("report_id"),
  status: windowStatus("status").notNull(),
  createdAt: createdAt(),
});

export const assignments = pgTable("assignments", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  windowId: uuid("window_id").notNull(),
  personId: uuid("person_id").notNull(),
  role: text("role").notNull(),
  status: assignmentStatus("status").notNull(),
  createdAt: createdAt(),
});

export const executionRecords = pgTable("execution_records", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  windowId: uuid("window_id").notNull(),
  kind: recordKind("kind").notNull(),
  subjectPersonId: uuid("subject_person_id"),
  qty: numeric("qty"),
  unit: text("unit"),
  startedAt: timestamptz("started_at"),
  endedAt: timestamptz("ended_at"),
  occurredAt: timestamptz("occurred_at").notNull(),
  receivedAt: timestamptz("received_at").notNull(),
  capturedByActor: jsonb("captured_by_actor").notNull(),
  deviceId: uuid("device_id"),
  supersedesId: uuid("supersedes_id"),
  clientKey: uuid("client_key").notNull(),
  status: recordStatus("status").notNull(),
  createdAt: createdAt(),
});

export const proofs = pgTable("proofs", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  recordId: uuid("record_id").notNull(),
  type: proofType("type").notNull(),
  storagePath: text("storage_path"),
  checklist: jsonb("checklist"),
  contentHash: text("content_hash").notNull(),
  capturedAt: timestamptz("captured_at").notNull(),
  status: proofStatus("status").notNull(),
  createdAt: createdAt(),
});

export const exceptions = pgTable("exceptions", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  siteId: uuid("site_id").notNull(),
  windowId: uuid("window_id"),
  commitmentId: uuid("commitment_id"),
  type: exceptionType("type").notNull(),
  severity: integer("severity").notNull(),
  ownerPersonId: uuid("owner_person_id"),
  dueAt: timestamptz("due_at").notNull(),
  sourceActor: jsonb("source_actor").notNull(),
  details: jsonb("details").notNull(),
  status: exceptionStatus("status").notNull(),
  createdAt: createdAt(),
});

export const escalationRules = pgTable("escalation_rules", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  scope: escalationScope("scope").notNull(),
  match: jsonb("match").notNull(),
  steps: jsonb("steps").notNull(),
  status: escalationRuleStatus("status").notNull(),
  createdAt: createdAt(),
});

export const escalationEvents = pgTable("escalation_events", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  exceptionId: uuid("exception_id").notNull(),
  ruleId: uuid("rule_id").notNull(),
  stepNo: integer("step_no").notNull(),
  notified: jsonb("notified").notNull(),
  occurredAt: timestamptz("occurred_at").notNull(),
  acknowledgedBy: uuid("acknowledged_by"),
  acknowledgedAt: timestamptz("acknowledged_at"),
  createdAt: createdAt(),
});

export const actionInvocations = pgTable("action_invocations", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  actionName: text("action_name").notNull(),
  actorType: invocationActorType("actor_type").notNull(),
  actorId: uuid("actor_id"),
  inputHash: text("input_hash").notNull(),
  result: jsonb("result"),
  status: invocationStatus("status").notNull(),
  createdAt: createdAt(),
});

export const agentProposals = pgTable("agent_proposals", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  agentCode: text("agent_code").notNull(),
  actionName: text("action_name").notNull(),
  input: jsonb("input").notNull(),
  editedInput: jsonb("edited_input"),
  rationale: text("rationale").notNull(),
  confidence: numeric("confidence"),
  refs: jsonb("refs").notNull(),
  expiresAt: timestamptz("expires_at").notNull(),
  decidedBy: uuid("decided_by"),
  decidedAt: timestamptz("decided_at"),
  invocationId: uuid("invocation_id"),
  status: proposalStatus("status").notNull(),
  createdAt: createdAt(),
});

export const recoveryActions = pgTable("recovery_actions", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  exceptionId: uuid("exception_id").notNull(),
  description: text("description").notNull(),
  kind: text("kind").notNull(),
  assignedTo: uuid("assigned_to"),
  dueAt: timestamptz("due_at"),
  proposalId: uuid("proposal_id"),
  completedAt: timestamptz("completed_at"),
  status: recoveryStatus("status").notNull(),
  createdAt: createdAt(),
});

export const reportShares = pgTable("report_shares", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  reportId: uuid("report_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  pinHash: text("pin_hash"),
  expiresAt: timestamptz("expires_at").notNull(),
  revokedAt: timestamptz("revoked_at"),
  viewCount: integer("view_count").notNull().default(0),
  lastViewedAt: timestamptz("last_viewed_at"),
  status: shareStatus("status").notNull(),
  createdAt: createdAt(),
});

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  clientId: uuid("client_id"),
  kind: documentKind("kind").notNull(),
  storagePath: text("storage_path").notNull(),
  status: documentStatus("status").notNull(),
  createdAt: createdAt(),
});

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  invocationId: uuid("invocation_id"),
  actorType: actorType("actor_type").notNull(),
  actorId: uuid("actor_id"),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  at: timestamptz("at").notNull(),
  createdAt: createdAt(),
  extras: jsonb("extras"),
});

export const outboundMessages = pgTable("outbound_messages", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  channel: messageChannel("channel").notNull(),
  to: jsonb("to").notNull(),
  templateKey: text("template_key").notNull(),
  payload: jsonb("payload").notNull(),
  sensitive: boolean("sensitive").notNull(),
  approvedBy: uuid("approved_by"),
  attempts: integer("attempts").notNull().default(0),
  sentAt: timestamptz("sent_at"),
  status: messageStatus("status").notNull(),
  createdAt: createdAt(),
});

export const schemaTables = {
  actionInvocations,
  agentProposals,
  assignments,
  auditEvents,
  authDevices,
  clients,
  commitments,
  documents,
  escalationEvents,
  escalationRules,
  exceptions,
  executionRecords,
  executionWindows,
  outboundMessages,
  persons,
  plans,
  proofs,
  recoveryActions,
  reportShares,
  reports,
  sites,
  workspaces,
};

export interface DrizzleColumnSnapshot {
  table: string;
  columns: { name: string; type: string; notNull: boolean }[];
}

export function drizzleSchemaColumns(): DrizzleColumnSnapshot[] {
  return Object.values(schemaTables)
    .map((table) => {
      const columns = Object.values(getTableColumns(table)) as {
        name: string;
        getSQLType(): string;
        notNull: boolean;
      }[];
      return {
        table: getTableName(table),
        columns: columns.map((column) => ({
          name: column.name,
          type: column.getSQLType(),
          notNull: column.notNull,
        })),
      };
    })
    .sort((a, b) => a.table.localeCompare(b.table));
}
