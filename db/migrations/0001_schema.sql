-- 0001_schema.sql — full v1 schema per ARCHITECTURE.md §3 (ships in Phase 0, §19).
-- Conventions (§3): app-generated UUIDv7 primary keys (no DB default — the app
-- supplies them; sole exception: plans keeps a text `code` PK, F9);
-- created_at timestamptz everywhere; snake_case plural table names; foreign
-- keys ON DELETE RESTRICT; nothing hard-deletes — lifecycle via status; every
-- tenant table has workspace_id uuid NOT NULL plus (workspace_id, …) indexes
-- on hot paths.

-- Enum types. audit_events.actor_type is exactly enum(person, agent, system)
-- per §3; action_invocations needs the additional 'platform' value for the
-- DEC-005 partial unique index, so it gets its own enum type.
CREATE TYPE workspace_status AS ENUM ('active', 'suspended');
CREATE TYPE role_class AS ENUM ('owner', 'manager', 'supervisor', 'worker');
CREATE TYPE person_status AS ENUM ('active', 'inactive', 'pseudonymized');
CREATE TYPE device_status AS ENUM ('pending', 'active', 'revoked');
CREATE TYPE client_status AS ENUM ('active', 'archived');
CREATE TYPE site_status AS ENUM ('active', 'archived');
CREATE TYPE commitment_type AS ENUM ('coverage', 'output', 'service_scope', 'proof', 'recovery');
CREATE TYPE commitment_status AS ENUM ('draft', 'active', 'paused', 'completed', 'archived');
CREATE TYPE window_status AS ENUM ('scheduled', 'open', 'fulfilled', 'shortfall', 'missed', 'closed');
CREATE TYPE assignment_status AS ENUM ('planned', 'confirmed', 'removed');
CREATE TYPE record_kind AS ENUM ('presence', 'coverage_confirm', 'output', 'service_confirmation', 'note');
CREATE TYPE record_status AS ENUM ('recorded', 'verified', 'superseded', 'voided');
CREATE TYPE proof_type AS ENUM ('photo', 'signature', 'checklist', 'note');
CREATE TYPE proof_status AS ENUM ('pending_upload', 'complete', 'failed');
CREATE TYPE exception_type AS ENUM ('no_show', 'under_coverage', 'output_shortfall', 'missing_proof', 'client_complaint', 'other');
CREATE TYPE exception_status AS ENUM ('open', 'owned', 'recovering', 'resolved', 'closed', 'cancelled');
CREATE TYPE escalation_scope AS ENUM ('workspace', 'client', 'site', 'commitment_type');
CREATE TYPE escalation_rule_status AS ENUM ('active', 'disabled');
CREATE TYPE recovery_status AS ENUM ('proposed', 'approved', 'in_progress', 'done', 'cancelled');
CREATE TYPE report_type AS ENUM ('leistungsnachweis', 'csv_export', 'digest');
CREATE TYPE report_status AS ENUM ('generating', 'ready', 'failed', 'superseded');
CREATE TYPE share_status AS ENUM ('active', 'revoked', 'expired');
CREATE TYPE proposal_status AS ENUM ('proposed', 'approved', 'rejected', 'expired', 'superseded');
CREATE TYPE document_kind AS ENUM ('order', 'einsatzvereinbarung', 'scope', 'other');
CREATE TYPE document_status AS ENUM ('uploaded', 'extracted', 'failed');
-- F30: the invocation row is inserted 'pending' and updated exactly once with
-- the response, so 'pending' joins §3's terminal statuses (ok, rejected, error).
CREATE TYPE invocation_status AS ENUM ('pending', 'ok', 'rejected', 'error');
CREATE TYPE invocation_actor_type AS ENUM ('person', 'agent', 'system', 'platform');
CREATE TYPE actor_type AS ENUM ('person', 'agent', 'system');
CREATE TYPE message_channel AS ENUM ('email', 'webpush', 'whatsapp', 'teams');
CREATE TYPE message_status AS ENUM ('queued', 'sent', 'failed', 'blocked');

-- plans — global config table (§3, F9): stable text code PK, no workspace_id.
CREATE TABLE plans (
  code text PRIMARY KEY,
  name text NOT NULL,
  limits jsonb NOT NULL,
  price jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- workspaces — tenant root (§3).
CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  plan_code text NOT NULL REFERENCES plans (code) ON DELETE RESTRICT,
  settings jsonb NOT NULL,
  status workspace_status NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE persons (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  role_class role_class NOT NULL,
  auth_user_id uuid,
  email text,
  phone text,
  locale text NOT NULL,
  pin_hash text,
  status person_status NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX persons_workspace_status_idx ON persons (workspace_id, status);
-- F11: one Supabase Auth identity resolves to at most one person per workspace.
CREATE UNIQUE INDEX persons_workspace_auth_user_key ON persons (workspace_id, auth_user_id)
  WHERE auth_user_id IS NOT NULL;

CREATE TABLE auth_devices (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  person_id uuid NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  label text NOT NULL,
  token_hash text NOT NULL,
  enrolled_by uuid NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  last_seen_at timestamptz,
  status device_status NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_devices_workspace_person_idx ON auth_devices (workspace_id, person_id);
-- Device requests resolve token hash → device before workspace context exists (§16).
CREATE UNIQUE INDEX auth_devices_token_hash_key ON auth_devices (token_hash);

CREATE TABLE clients (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  name text NOT NULL,
  contact jsonb NOT NULL,
  status client_status NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX clients_workspace_status_idx ON clients (workspace_id, status);

CREATE TABLE sites (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  client_id uuid NOT NULL REFERENCES clients (id) ON DELETE RESTRICT,
  name text NOT NULL,
  address jsonb NOT NULL,
  -- settings includes supervisor_person_ids — the authz source for supervisor
  -- site scope (F12).
  settings jsonb NOT NULL,
  status site_status NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sites_workspace_client_idx ON sites (workspace_id, client_id);
CREATE INDEX sites_workspace_status_idx ON sites (workspace_id, status);

CREATE TABLE commitments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  client_id uuid NOT NULL REFERENCES clients (id) ON DELETE RESTRICT,
  site_id uuid NOT NULL REFERENCES sites (id) ON DELETE RESTRICT,
  type commitment_type NOT NULL,
  title text NOT NULL,
  spec jsonb NOT NULL,
  schedule_rrule text NOT NULL,
  target_qty numeric,
  unit text,
  verification jsonb NOT NULL,
  valid_from date NOT NULL,
  valid_to date NOT NULL,
  status commitment_status NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commitments_workspace_site_status_idx ON commitments (workspace_id, site_id, status);
CREATE INDEX commitments_workspace_client_idx ON commitments (workspace_id, client_id);

CREATE TABLE reports (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  client_id uuid REFERENCES clients (id) ON DELETE RESTRICT,
  type report_type NOT NULL,
  params jsonb NOT NULL,
  period daterange NOT NULL,
  snapshot_path text NOT NULL,
  version integer NOT NULL,
  generated_by_actor jsonb NOT NULL,
  status report_status NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_workspace_client_idx ON reports (workspace_id, client_id);
CREATE INDEX reports_workspace_type_idx ON reports (workspace_id, type);

CREATE TABLE execution_windows (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  commitment_id uuid NOT NULL REFERENCES commitments (id) ON DELETE RESTRICT,
  site_id uuid NOT NULL REFERENCES sites (id) ON DELETE RESTRICT,
  date date NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  -- target_qty/unit are frozen copies of the commitment values (A3); the
  -- source columns are nullable (service_scope has no numeric target), so the
  -- frozen copies must be too.
  target_qty numeric,
  unit text,
  requirements jsonb NOT NULL,
  fulfillment jsonb NOT NULL,
  closed_by uuid REFERENCES persons (id) ON DELETE RESTRICT,
  closed_at timestamptz,
  -- F14: points at the latest ready leistungsnachweis/csv_export report that
  -- includes this window (the reopen lock).
  report_id uuid REFERENCES reports (id) ON DELETE RESTRICT,
  status window_status NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX execution_windows_workspace_site_date_idx ON execution_windows (workspace_id, site_id, date);
CREATE INDEX execution_windows_workspace_commitment_date_idx ON execution_windows (workspace_id, commitment_id, date);
CREATE INDEX execution_windows_workspace_status_idx ON execution_windows (workspace_id, status);

CREATE TABLE assignments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  window_id uuid NOT NULL REFERENCES execution_windows (id) ON DELETE RESTRICT,
  person_id uuid NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  role text NOT NULL,
  -- 'confirmed' is reserved and unreachable in v1 (F22).
  status assignment_status NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assignments_workspace_window_idx ON assignments (workspace_id, window_id);
CREATE INDEX assignments_workspace_person_idx ON assignments (workspace_id, person_id);

-- execution_records — immutable capture facts (§3, §4, §6): corrected only by
-- supersede or void, never by update; enforcement in 0003_immutability.sql.
CREATE TABLE execution_records (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  window_id uuid NOT NULL REFERENCES execution_windows (id) ON DELETE RESTRICT,
  kind record_kind NOT NULL,
  subject_person_id uuid REFERENCES persons (id) ON DELETE RESTRICT,
  qty numeric,
  unit text,
  started_at timestamptz,
  ended_at timestamptz,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  captured_by_actor jsonb NOT NULL,
  device_id uuid REFERENCES auth_devices (id) ON DELETE RESTRICT,
  supersedes_id uuid REFERENCES execution_records (id) ON DELETE RESTRICT,
  client_key uuid NOT NULL,
  status record_status NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX execution_records_workspace_window_idx ON execution_records (workspace_id, window_id);

-- proofs — immutable capture facts alongside execution_records (§3, A2, §6).
CREATE TABLE proofs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  record_id uuid NOT NULL REFERENCES execution_records (id) ON DELETE RESTRICT,
  type proof_type NOT NULL,
  storage_path text,
  checklist jsonb,
  content_hash text NOT NULL,
  captured_at timestamptz NOT NULL,
  status proof_status NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proofs_workspace_record_idx ON proofs (workspace_id, record_id);
CREATE INDEX proofs_workspace_status_idx ON proofs (workspace_id, status);

CREATE TABLE exceptions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  site_id uuid NOT NULL REFERENCES sites (id) ON DELETE RESTRICT,
  window_id uuid REFERENCES execution_windows (id) ON DELETE RESTRICT,
  commitment_id uuid REFERENCES commitments (id) ON DELETE RESTRICT,
  type exception_type NOT NULL,
  severity integer NOT NULL CHECK (severity BETWEEN 1 AND 4),
  owner_person_id uuid REFERENCES persons (id) ON DELETE RESTRICT,
  due_at timestamptz NOT NULL,
  source_actor jsonb NOT NULL,
  details jsonb NOT NULL,
  status exception_status NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX exceptions_workspace_status_due_idx ON exceptions (workspace_id, status, due_at);
CREATE INDEX exceptions_workspace_site_idx ON exceptions (workspace_id, site_id);

CREATE TABLE escalation_rules (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  scope escalation_scope NOT NULL,
  match jsonb NOT NULL,
  steps jsonb NOT NULL,
  status escalation_rule_status NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX escalation_rules_workspace_status_idx ON escalation_rules (workspace_id, status);

-- escalation_events — naturally append-only; guarded inside core/domain, not
-- by triggers (F30 fixes the trigger-protected set to exactly
-- {audit_events, execution_records, proofs}).
CREATE TABLE escalation_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  exception_id uuid NOT NULL REFERENCES exceptions (id) ON DELETE RESTRICT,
  rule_id uuid NOT NULL REFERENCES escalation_rules (id) ON DELETE RESTRICT,
  step_no integer NOT NULL,
  notified jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  acknowledged_by uuid REFERENCES persons (id) ON DELETE RESTRICT,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX escalation_events_workspace_exception_idx ON escalation_events (workspace_id, exception_id);

-- action_invocations — idempotency ledger (§3, §5, F24, F30): inserted
-- 'pending' and updated exactly once with the full response envelope inside
-- the same kernel transaction. Deliberately outside the trigger-protected set.
CREATE TABLE action_invocations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  action_name text NOT NULL,
  actor_type invocation_actor_type NOT NULL,
  actor_id uuid,
  input_hash text NOT NULL,
  result jsonb,
  status invocation_status NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- §5 [FIXED]: replay is matched on (workspace_id, idempotency_key).
  CONSTRAINT action_invocations_workspace_idempotency_key UNIQUE (workspace_id, idempotency_key)
);
-- DEC-005 (Option A): platform-actor invocations (tenant-root bootstrap,
-- workspace.create) are replay-matched by (idempotency_key, actor_type=platform)
-- kernel-internally; this partial index enforces global key uniqueness for
-- platform invocations only. Non-platform scoping is unchanged.
CREATE UNIQUE INDEX action_invocations_platform_idempotency_key ON action_invocations (idempotency_key)
  WHERE actor_type = 'platform';

CREATE TABLE agent_proposals (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  agent_code text NOT NULL,
  action_name text NOT NULL,
  input jsonb NOT NULL,
  edited_input jsonb,
  rationale text NOT NULL,
  confidence numeric,
  refs jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  decided_by uuid REFERENCES persons (id) ON DELETE RESTRICT,
  decided_at timestamptz,
  invocation_id uuid REFERENCES action_invocations (id) ON DELETE RESTRICT,
  status proposal_status NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_proposals_workspace_status_expires_idx ON agent_proposals (workspace_id, status, expires_at);

CREATE TABLE recovery_actions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  exception_id uuid NOT NULL REFERENCES exceptions (id) ON DELETE RESTRICT,
  description text NOT NULL,
  kind text NOT NULL,
  assigned_to uuid REFERENCES persons (id) ON DELETE RESTRICT,
  due_at timestamptz,
  proposal_id uuid REFERENCES agent_proposals (id) ON DELETE RESTRICT,
  completed_at timestamptz,
  status recovery_status NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recovery_actions_workspace_exception_idx ON recovery_actions (workspace_id, exception_id);

CREATE TABLE report_shares (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  report_id uuid NOT NULL REFERENCES reports (id) ON DELETE RESTRICT,
  token_hash text NOT NULL,
  pin_hash text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  view_count integer NOT NULL DEFAULT 0,
  last_viewed_at timestamptz,
  status share_status NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX report_shares_workspace_report_idx ON report_shares (workspace_id, report_id);
-- Anonymous /s/{token} lookups resolve the hashed token before any workspace
-- context exists (§12).
CREATE UNIQUE INDEX report_shares_token_hash_key ON report_shares (token_hash);

CREATE TABLE documents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  client_id uuid REFERENCES clients (id) ON DELETE RESTRICT,
  kind document_kind NOT NULL,
  storage_path text NOT NULL,
  status document_status NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_workspace_client_idx ON documents (workspace_id, client_id);

-- audit_events — append-only audit log (§3, §6), written by the kernel in the
-- same transaction as the mutation; enforcement in 0003_immutability.sql.
CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  invocation_id uuid REFERENCES action_invocations (id) ON DELETE RESTRICT,
  actor_type actor_type NOT NULL,
  actor_id uuid,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  before jsonb,
  after jsonb,
  at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_workspace_entity_idx ON audit_events (workspace_id, entity_type, entity_id);
CREATE INDEX audit_events_workspace_at_idx ON audit_events (workspace_id, at);

CREATE TABLE outbound_messages (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  channel message_channel NOT NULL,
  "to" jsonb NOT NULL,
  template_key text NOT NULL,
  payload jsonb NOT NULL,
  sensitive boolean NOT NULL,
  approved_by uuid REFERENCES persons (id) ON DELETE RESTRICT,
  attempts integer NOT NULL DEFAULT 0,
  sent_at timestamptz,
  status message_status NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbound_messages_workspace_status_idx ON outbound_messages (workspace_id, status);
