# Ops Control Plane — v1.0 Architecture & Implementation Plan

Status: ruling document, binding for implementation. Architect and later judge: Fable. Implementers: coding agents under solo-operator supervision, one phase at a time. Commit this file as `ARCHITECTURE.md` at repo root. Date: 2026-07-05 (v1.0).

## 1. Architecture ruling

One Next.js application on Vercel with Supabase (Postgres + Storage + Auth) in the EU, and one internal `core` package that *is* the product: typed entities, five explicit state machines, a code-registered **action layer** through which every mutation flows (authorize → entitlement gate → threshold gate → validate → execute in one transaction → append audit event), and a typed read layer. Manager dashboard, supervisor PWA, share pages, cron jobs, agents, reports, and the future API/MCP are thin mounts over the same actions and reads — no business logic exists outside `core`. Source of truth is relational current state plus an append-only audit log; capture facts (ExecutionRecords, Proofs) are immutable rows corrected only by supersede or void, never by update. Offline capture is an outbox of idempotent action invocations. Tenancy is `workspace_id` on every row with RLS as a backstop behind a server-only data path. Commitment types are code-defined type definitions validating a JSONB spec; verticals are template bundles over the same primitives, never forks. Agents are registered actors calling the same actions under threshold classes, with a measured promotion path from proposal-gated to autonomous-safe.

## 2. System boundaries

**Inside:** the category loop end to end — typed Commitments, generated ExecutionWindows, supervisor capture (ExecutionRecords + Proofs), Exceptions with EscalationRules/Events and RecoveryActions, Reports (Leistungsnachweis, CSV export), external share links, AI onboarding extraction as AgentProposals, entitlements, and the audit trail underneath all of it.

**Hard edges (never inside):** pay/tax/invoice calculation — the versioned CSV export contract is the boundary: we prove delivery, we never compute pay. Also outside: rostering/availability/vacation, ATS/CRM, disposition or matching optimization, chat, CAFM/material management, generic form builder, compliance-as-category. A grep for pay-calculation, rostering, or chat code is a review failure (§21.19).

**Actors:** owner, manager (paid seats), supervisor (free capture role, elevated rights), worker (no login in v1; read-own access later), client viewer (share link, no account), agent (registered non-human actor), system (cron/detectors).

**External systems in v1:** outbound transactional email (Resend), Anthropic API (agent tasks, server-side only), Supabase Storage (proofs, report snapshots, documents), Vercel cron. Inbound: document upload only. Everything else is a later adapter, not a v1 dependency. [FIXED]: the export boundary. [FLEX]: which adapters come when.

## 3. Domain model

Conventions, binding for all tables: app-generated **UUIDv7** primary keys (offline-friendly, index-friendly) — the sole exception is global config tables (`plans`), which keep a stable text `code` primary key (F9); `created_at timestamptz` everywhere; snake_case plural table names mapping 1:1 to entities; foreign keys `ON DELETE RESTRICT`; nothing hard-deletes — lifecycle via `status`; every tenant table has `workspace_id uuid NOT NULL` plus composite indexes `(workspace_id, …)` on hot paths.

| Entity / table | Key fields (type) | Relations | States | Tenancy |
|---|---|---|---|---|
| workspaces | name, slug, plan_code→plans, settings jsonb (tz, branding, default locale, action_policies), status | tenant root | active, suspended | is root |
| persons | display_name, role_class enum(owner, manager, supervisor, worker), auth_user_id uuid? (Supabase Auth user; unique per workspace; populated at invite acceptance — F11), email?, phone?, locale, pin_hash? (reserved; unused in v1), status | workspace | active, inactive, pseudonymized | workspace_id |
| auth_devices | person_id, label, token_hash, enrolled_by, last_seen_at, status — reserved; unused in v1 | person | pending, active, revoked | workspace_id |
| clients | name, contact jsonb, status | workspace | active, archived | workspace_id |
| sites | client_id, name, address jsonb, settings jsonb (incl. `supervisor_person_ids` — the authz source for supervisor site scope, F12), status | client | draft, active, archived | workspace_id |
| commitments | client_id, site_id, type enum(coverage, output, service_scope, proof, recovery), title, spec jsonb (validated by type def), schedule_rrule text, target_qty numeric?, unit text?, verification jsonb (`{proof: {required: bool, types: ('photo'\|'signature')[], min_count}}`), valid_from, valid_to, status | site, client | §4 | workspace_id |
| execution_windows | commitment_id, site_id, date, starts_at, ends_at, target_qty, unit, requirements jsonb (frozen `{verification, checklist?}`, derived solely from the commitment at generation, A3), fulfillment jsonb (computed `{rule, target_qty, unit, verified_qty?\|confirmed_headcount?\|checklist_state?, satisfied, counted_record_ids, computed_at}`), closed_by?, closed_at?, report_id?, status | commitment | §4 | workspace_id |
| assignments | window_id, person_id, role text, status(planned, confirmed [reserved, unreachable in v1 — F22], removed) | window, person | — | workspace_id |
| execution_records | window_id, kind enum(presence, coverage_confirm, output, service_confirmation, note), subject_person_id?, qty numeric?, unit?, started_at?, ended_at?, note text?, occurred_at, received_at, captured_by_actor, device_id? (reserved; always NULL in v1), supersedes_id?, client_key, status | window | §4 | workspace_id |
| proofs | record_id, type enum(photo, signature, checklist, note), storage_path?, checklist jsonb?, content_hash, captured_at, status(pending_upload, complete, failed) | record (A2) | — | workspace_id |
| exceptions | site_id, window_id?, commitment_id?, type enum(no_show, under_coverage, output_shortfall, missing_proof, client_complaint, other), severity int 1–4, owner_person_id?, due_at, source_actor, details jsonb, status | site/window | §4 | workspace_id |
| escalation_rules | scope enum(workspace, client, site, commitment_type), match jsonb, steps jsonb array of {after_min, notify_roles/persons, raise_severity}, status | workspace | active, disabled | workspace_id |
| escalation_events | exception_id, rule_id, step_no, notified jsonb, occurred_at, acknowledged_by?, acknowledged_at? | exception | — | workspace_id |
| recovery_actions | exception_id, description, kind text, assigned_to?, due_at?, proposal_id?, completed_at?, status | exception | proposed, approved, in_progress, done, cancelled | workspace_id |
| reports | client_id?, type enum(leistungsnachweis, csv_export, digest), params jsonb, period daterange, snapshot_path, version int, generated_by_actor, status | client | generating, ready, failed, superseded | workspace_id |
| report_shares | report_id, token_hash, pin_hash?, expires_at, revoked_at?, view_count, last_viewed_at? | report (A4) | active, revoked, expired | workspace_id |
| agent_proposals | agent_code, action_name, input jsonb, edited_input jsonb?, rationale text, confidence?, refs jsonb, expires_at, decided_by?, decided_at?, invocation_id?, status | any entity via refs | §4 | workspace_id |
| documents | client_id?, kind enum(order, einsatzvereinbarung, scope, other), storage_path, status(uploaded, extracted, failed) | client | — | workspace_id |
| action_invocations | idempotency_key, action_name, actor_type, actor_id, input_hash, result jsonb (stores the full `{status, result, warnings}` response envelope so a replay is byte-identical — F24), status(ok, rejected, error) — unique (workspace_id, idempotency_key); row is inserted pending and updated exactly once with the response inside the same kernel transaction (F30) | — | — | workspace_id |
| audit_events | invocation_id?, actor_type enum(person, agent, system), actor_id?, action, entity_type, entity_id, before jsonb?, after jsonb?, at | everything | insert-only | workspace_id |
| outbound_messages | channel enum(email, webpush, whatsapp, teams), to jsonb, template_key, payload jsonb, sensitive bool, approved_by?, attempts, sent_at?, status | — | queued, sent, failed, blocked | workspace_id |
| plans | code PK, name, limits jsonb (active_sites, manager_seats, features), price jsonb | global config | — | none (global) |

**Commitment type definitions** are code, in `core/domain/commitment-types/`: per type — a Zod schema for `spec`, the required verification (which record kinds and proof types can satisfy a window), the fulfillment rule (how verified records aggregate against the frozen `target_qty`), shortfall/exception triggers, and capture-UI hints. Every v1 `spec` carries `{window_start_time, window_end_time}` as local wall-clock strings in the workspace timezone; RRULE governs dates only, and each occurrence date is converted independently so generated windows remain DST-correct. `service_scope` additionally carries `{checklist: [{key, label}]}`; coverage and output add no type-specific spec fields because quantity and unit remain fixed columns. **Canonical type↔record-kind↔fulfillment mapping for v1 (F10):** `coverage` → record kind `coverage_confirm` (headcount) and/or `presence` (per-person) → confirmed headcount is `max(max qty over verified coverage_confirm records, count of distinct subject_person_id over verified presence records)`, and fulfilled when that value ≥ frozen `target_qty`; `output` → record kind `output` → fulfilled when Σ verified `qty` ≥ frozen `target_qty`; `service_scope` → record kind `service_confirmation` carrying a checklist-type proof whose `proofs.checklist` is `{items: [{key, done, note?}]}` against the frozen keys → fulfilled when every required key is done on the latest verified record's proof, with shortfall raising `output_shortfall`. The `note` record kind is cross-cutting and never satisfies fulfillment. The `proof` and `recovery` commitment-type enum values are **reserved for later and carry no v1 type definition** — they are excluded from Phase 1, and no window, satisfying record kind, or fulfillment rule is defined for them in v1 (F10). A **vertical template** = a bundle of type defaults + escalation rules + a report template + catalog labels, applied as workspace config. A new commitment type or a new vertical is a new definition file plus a template bundle — zero schema migrations, zero forks. This answers open question 1. [FIXED]: the fixed-column/JSONB-spec split and code-registered definitions. [FLEX]: moving definitions from code registry to a DB registry when a customer needs custom types (§18).

The additive nullable `execution_records.note text` fact column is required (1–2000 characters) only for `kind=note` and forbidden for every other kind. The DEC-016-authorized migration and the corresponding F4 immutability-trigger update ride the SLICE-016 implementation PR, not this documentation PR.

Strongest rejected alternative: fully dynamic schema (EAV / form-builder style) — it is the excluded form builder in disguise, agent-illegible, and unqueryable for the board. Cost of the chosen ruling being wrong: if a fixed column is missing, one migration on a live pilot — bounded and recoverable.

## 4. State model

Actor legend: O owner, M manager, S supervisor, A agent, Y system. All transitions execute only inside `core/domain` state machines, invoked via actions (§5); status writes anywhere else are a review failure (§21.8).

**Commitment**

| From → To | Action / trigger | Allowed actors |
|---|---|---|
| draft → active | commitment.activate | O, M (agents only via approved proposal) |
| active → paused | commitment.pause | O, M |
| paused → active | commitment.activate | O, M |
| active/paused → completed | valid_to reached, or commitment.complete | Y, O, M |
| draft/completed → archived | commitment.archive (only if no open windows — i.e. no attached window in any status other than `closed`, F23) | O, M |

Spec edits: free while draft; on active commitments `commitment.update_spec` affects only windows generated after the edit (A3).

**ExecutionWindow**

| From → To | Action / trigger | Allowed actors |
|---|---|---|
| scheduled → open | window.open — starts_at reached (cron, nat key) or early open (F1) | Y, S, M |
| open → fulfilled / shortfall | window.close — fulfillment computed from verified records vs frozen target per type definition | S, M |
| open → missed | ends_at + grace passed with zero verified records | Y |
| fulfilled ↔ shortfall | fulfillment recompute after a verified record capture, verify, void, or supersede | Y |
| missed → fulfilled / shortfall | fulfillment recompute after a late verified record capture, verify, void, or supersede | Y |
| fulfilled/shortfall/missed → closed | window.reconcile (lock), or auto after 48h | M, Y |
| closed → open | window.reopen — permitted only until the window is included in a `ready` `leistungsnachweis` or `csv_export` report (digests never lock — F14); the lock is permanent once any such qualifying report version has included the window; afterwards corrections happen via superseding records + report regeneration (new version) | M (human-only) |

`window.generate` considers only active commitments. Already-generated scheduled windows of paused or completed commitments remain and run their course through open/close or missed; Phase 1 adds no cancelled state. Record events are accepted on every window not in `closed`; recompute may take the system-triggered transitions above so the status and `fulfillment` object never disagree. A `closed` window rejects capture with a typed code. shortfall and missed auto-raise Exceptions; `fulfillment` is recomputed on every verified record capture/verify/void/supersede.

**ExecutionRecord** (immutable fact; corrections are new rows)

| From → To | Action | Allowed actors |
|---|---|---|
| (offline outbox) → verified | record.capture accepted by kernel — capture by S/M writes the record directly to `verified` in a single audit event marked auto-verified, with `verified_by` = the capturing actor (F32) | S, M (workers later) |
| recorded → verified | explicit record.verify — registered in v1 (M, Y) but reserved for lower-trust sources and unused by the v1 capture UI; only such sources land in `recorded` first (F32) | Y, M |
| verified → superseded | record.supersede — new correcting record links supersedes_id | S, M |
| recorded/verified → voided | record.void (reason required) | M |

**Exception**

| From → To | Action / trigger | Allowed actors |
|---|---|---|
| — → open | exception.raise | Y (detectors), S, M; A proposal-gated |
| open → owned | exception.claim / exception.assign (compare-and-set on owner) | S, M |
| owned → recovering | recovery.start — a RecoveryAction enters `in_progress` (see RecoveryAction lifecycle below) | S, M |
| recovering → resolved | recovery.complete with closure condition met (≥1 RecoveryAction in `done`) | S, M |
| resolved → closed | exception.close (verification), or auto after 7 days | M, Y |
| open/owned → cancelled | exception.cancel (reason required) | M |

Escalation is an attribute path, not a state: `escalation.tick` (Y) fires rule steps when due_at is breached → escalation_events + notifications + severity raise; each step's `after_min` is measured from the due_at breach as its zero-point, not from raise time (F23); acknowledgement is recorded per event.

**RecoveryAction lifecycle (F15):** `proposed` →(recovery.approve, M)→ `approved` →(recovery.start, S/M)→ `in_progress` →(recovery.complete, S/M)→ `done`. A manager may skip `recovery.approve` for a recovery they created themselves, starting it directly; supervisors may start/complete only `approved` recoveries (§8). `recovery.cancel` (M, reason required — F1) moves any non-`done` recovery to `cancelled`. `exception.close` requires ≥1 RecoveryAction in `done`.

**Detector → exception mapping (F16).** Auto-raised exceptions land in `open`; claiming is a separate step (Phase 2's done-means is "exactly one open exception, and claiming it walks the full lifecycle"):

| Detector | Exception type | Default severity | due_at |
|---|---|---|---|
| missed window (0 verified records by ends_at + grace) | no_show | 3 | raise + per-severity offset (App. A) |
| coverage shortfall on close | under_coverage | 2 | raise + per-severity offset |
| output shortfall on close | output_shortfall | 2 | raise + per-severity offset |
| missing_proof timeout | missing_proof | 1 | raise + per-severity offset |
| unstaffed window at T-minus | no_show | 3 | window.starts_at (anticipatory) |

Manual raises (incl. client_complaint) take type/severity/due_at from the form; when due_at is omitted it defaults to raise + the per-severity offset (Appendix A).

**AgentProposal**

| From → To | Action / trigger | Allowed actors |
|---|---|---|
| — → proposed | kernel threshold-gate conversion of an agent invocation that requires approval (F2) | A |
| proposed → approved | proposal.approve — re-runs authorize + entitlement gates against the approving human, then executes the underlying action in the same transaction attributed to that human (actor_type=person), storing invocation_id, the edited-input diff, and the originating `agent_code` in audit extras (F2); approver authority is checked against the *underlying* action's scope (F18) | O, M; S for capture-scope only |
| proposed → rejected | proposal.reject (reason) | O, M, S |
| proposed → expired | proposal.expire — expires_at reached (Y, nat key, F1) | Y |
| proposed → superseded | proposal.supersede — agent re-proposes on changed context (F1) | A, Y |

**Capture-scope proposals (F18)** = proposals whose underlying action is one of `record.capture`, `proof.attach`, `window.close`, `exception.raise`, `assignment.set`. `proposal.approve` authorization is evaluated against that underlying action, so a supervisor may approve a proposal only when its underlying action falls in this set — never, e.g., `person.create`.

## 5. Action layer

**Ruling [FIXED]:** one kernel, one dispatch surface, no second write path — this answers open question 3. Pipeline per invocation: resolve actor → authorize (role × action matrix; for agent actors this admits any action not classified `human_only` and defers the execute-vs-propose decision to the threshold gate — F2) → entitlement gates (§9) → threshold gate (agent actors) → Zod-validate input → open transaction → execute domain function (state machines enforce transitions) → write audit event(s) → commit → persist invocation result. Server Components, route handlers, cron, and agents all call the same kernel function; the HTTP surface is `POST /api/actions` with `{name, input, idempotency_key}` returning `{status, result, warnings}`. Reads go through `core/reads` mounted at `GET /api/reads/:name` — the *initial* v1 read catalog is board_day_pack, window_detail, exception_list, report_data, proposal_inbox, admin_lists (manager-scoped audit reads fold into admin_lists; the Phase 5 promotion-stats view is an added read). This catalog is not a closed set: adding a read is an implementation detail recorded in PR DEVIATIONS, not a scope breach (F29). Action and read Zod schemas are exported as JSON Schema at build time — that export *is* the future public API and MCP tool surface (open question 8); nothing more is built now.

**Idempotency [FIXED]:** every invocation carries a key; unique `(workspace_id, idempotency_key)`; a replay matched on `(workspace_id, idempotency_key)` returns the stored full `{status, result, warnings}` envelope byte-identical — no re-execution, no duplicate audit event — while the same key presented with a different `input_hash` is a typed rejection (`status=rejected`, no execution); a warned no-op (e.g. window.close on an already-closed window, §11) still writes one audit event carrying a no-op marker (F24). Human clients generate a UUIDv4 per invocation; system actions use deterministic natural keys (e.g., `window.generate:{commitment_id}:{date}`, `escalation.tick:{exception_id}:{step}`) so every cron is safely re-runnable.

**Threshold classes** — they govern *agent* actors; humans are governed by the role matrix. An agent may *invoke* any action not classified `human_only`, whether or not its catalog actor column names A (the actor columns govern humans and system); the threshold class then decides direct execution vs proposal conversion, and `proposal.approve` re-checks authorization + entitlement against the approving human, who becomes the recorded actor with the originating `agent_code` in audit extras (F2):

- **autonomous_safe** — agent executes directly, fully audited.
- **proposal_gated** — an agent invocation is converted into an AgentProposal; execution happens only via human approve.
- **human_only** — never executed with actor=agent (agents may attach drafts to entities, but the action requires a human): personnel/legal/financial consequences, sensitive external sends, reopening closed windows, voiding records, policy changes.

Defaults live in the code registry. Per-workspace overrides in `workspaces.settings.action_policies` may only tighten — except through the promotion path (§13), which is itself a human-only, audited action. Demotion auto-tightens on incident: the system may always increase safety, never decrease it.

**Action catalog.** Audit payload always includes invocation_id, actor, entity refs, and before/after diff; the Audit-extras column lists additions. Idempotency key is a client UUIDv4 unless a deterministic key is noted.

| Action | Actors | Input (key fields) | Threshold | Audit extras | Idempotency key |
|---|---|---|---|---|---|
| workspace.create | platform | name, plan_code | human_only | plan snapshot | client uuid |
| person.create / person.update | O, M | role_class, name, contact | proposal_gated | role changes | client uuid |
| person.deactivate | O, M | person_id, reason | human_only | reason | client uuid |
| person.pseudonymize | O | person_id | human_only | GDPR basis note | client uuid |
| person.invite | O, M | person_id | human_only | auth invite id | client uuid |
| client.create / update / archive | O, M | fields | proposal_gated | — | client uuid |
| site.create / update | O, M | client_id, fields | proposal_gated | — | client uuid |
| site.activate / site.archive | O, M | site_id | human_only (billing meter) | meter delta | client uuid |
| commitment.draft | O, M, A | flat fields: `site_id` (active site; `client_id` derived), `type`, `title` (1–200), `spec` (type schema), `schedule_rrule` (valid RRULE), `verification?` (type default), `valid_from`, `valid_to` (required, ≥ valid_from); coverage requires integer `target_qty` ≥1 and forbids `unit`; output requires `target_qty` >0 and `unit`; service_scope forbids both | proposal_gated (humans draft directly; an agent's draft converts to a proposal — F3) | type-def version | client uuid |
| commitment.activate | O, M | commitment_id | human_only | frozen spec hash | client uuid |
| commitment.update_spec | O, M | patch: `commitment_id` plus any of `title`, `spec`, `schedule_rrule`, `target_qty`, `unit`, `verification`, `valid_from` (draft only), `valid_to`; empty patch rejected; `type` and `site_id` immutable; type validation re-runs | proposal_gated | before/after spec | client uuid |
| commitment.pause / complete / archive | O, M; Y for auto-complete when valid_to is reached (F1) | id, reason | human_only (the Y auto-complete is a system tick, not agent-invocable) | — | client uuid / nat: commitment.complete:{commitment_id} |
| window.generate | Y | commitment_id, date | autonomous_safe | frozen targets | nat: window.generate:{commitment_id}:{date} |
| window.open | Y, S, M | window_id | autonomous_safe | — | nat: window.open:{window_id} (cron) / client uuid (early open) |
| window.close | S, M | `window_id`, `counts?` = `{headcount: int}` \| `{total_qty: number, unit: string}` \| `{checked_items: int}` (advisory client echo only; fulfillment derives solely from verified records — mismatch returns the server result with warning `counts_mismatch`, no exception, F20) | proposal_gated | fulfillment calculation, counts-mismatch warning | client uuid |
| window.reconcile | M, Y | window_id | human_only (M) / auto (Y) | — | client uuid / nat |
| window.reopen | M | window_id, reason | human_only | reason | client uuid |
| assignment.set / remove | M, S | `window_id`, `person_id`; set is an idempotent upsert to `planned` (revives `removed`), unique on (window_id, person_id), snapshots the active in-workspace person's `role_class` into `role`; role is not an input; assignments never authorize (A1) | autonomous_safe | — | client uuid |
| record.capture | S, M | common: `window_id`, `kind`, `occurred_at`, `client_key`; presence requires active in-workspace `subject_person_id`, permits `started_at`/`ended_at`, forbids qty/unit; coverage_confirm requires integer `qty` ≥0, forbids unit/subject/times; output requires `qty` >0 and `unit` equal to frozen window unit (`unit_mismatch` otherwise), permits subject; service_confirmation forbids qty/unit and carries checklist via proof; note requires `note` (1–2000), forbids quantitative fields | proposal_gated | device_id reserved/NULL in v1, occurred_at vs received_at skew, auto-verified marker (F32) | client uuid (= client_key) |
| record.verify | M, Y | record_id | proposal_gated | — (registered in v1, unused by the capture UI — F32) | client uuid |
| record.supersede | S, M | `record_id`, correction = the inherited kind's record.capture fields minus `window_id` and `kind` (both immutable and copied), plus fresh `client_key`; verified targets only | human_only | links both records | client uuid |
| record.void | M | record_id, reason | human_only | reason | client uuid |
| proof.attach | S, M | `{record_id, type, content_hash, byte_size}` where content_hash is the client SHA-256 of the original blob → `{proof_id, upload: {url, method, headers, expires_at}}`; complete_upload verifies it, re-encodes/strips, and records the stored-object hash in audit extras | autonomous_safe | original content hash | client uuid |
| proof.complete_upload | S, M, Y | proof_id | autonomous_safe | storage path | client uuid |
| exception.raise | Y, S, M, A | type, refs, severity, due_at | autonomous_safe (Y detectors); proposal_gated (A) | detector rule | nat for detectors: {rule}:{window_id} |
| exception.claim / assign | S, M | exception_id (CAS on owner) | proposal_gated | prior owner | client uuid |
| exception.cancel | M | exception_id, reason | human_only | reason | client uuid |
| recovery.propose | A, S, M | exception_id, options | autonomous_safe (creates drafts/proposals) | option set | client uuid |
| recovery.approve | M | recovery_id | human_only | chosen option | client uuid |
| recovery.start / complete | S, M | recovery_id, evidence refs | proposal_gated | evidence refs | client uuid |
| recovery.cancel | M | recovery_id, reason | human_only | reason | client uuid |
| exception.close | M, Y | exception_id | human_only (M) | verification note | client uuid |
| escalation.tick | Y | exception_id, step | autonomous_safe | notified set | nat: escalation.tick:{exception_id}:{step} |
| escalation.acknowledge | S, M | event_id | autonomous_safe | — | client uuid |
| escalation_rule.create / update | O, M | scope, match, steps | proposal_gated | steps diff | client uuid |
| escalation_rule.enable | O, M | rule_id | proposal_gated | — | client uuid |
| escalation_rule.disable | O, M | rule_id, reason | human_only | reason | client uuid |
| report.generate | M, A, Y | type ∈ {leistungsnachweis, digest} — *excludes* csv_export (F26); client, period | autonomous_safe (produces draft artifact) | snapshot hash, version | client uuid / nat for digests |
| report.share_create | M | report_id, expiry, pin? | human_only | recipient label | client uuid |
| report.share_revoke | M | share_id | autonomous_safe | — | client uuid |
| export.generate | M | period, client? — the sole producer of `type=csv_export` report rows (F26) | human_only | contract version | client uuid |
| notify.send | Y, M | message_id | autonomous_safe if sensitive=false; human_only if sensitive | channel, template | nat: message_id |
| doc.upload | M, S | file meta | autonomous_safe | content hash | client uuid |
| doc.extract_commitments | A, M | document_id | autonomous_safe (output = proposal batch) | model, token counts | nat: extract:{document_id}:{version} |
| proposal.approve / reject | O, M; S for capture-scope proposals only (F18) | proposal_id, edits? | human_only | edit diff, originating agent_code, gates-rechecked note | client uuid |
| proposal.expire | Y | proposal_id | human_only (system sweep; never agent-invocable) | — | nat: proposal.expire:{proposal_id} |
| proposal.supersede | A, Y | proposal_id, replacement refs | autonomous_safe | prior proposal ref | client uuid / nat |
| policy.promote_action | O | action_name, evidence window | human_only | reliability stats snapshot | client uuid |
| policy.demote_action | Y | action_name, agent, triggering exception_id | autonomous_safe (system safety-tighten only; never promotes — F31) | attribution ref | nat: policy.demote:{workspace}:{action}:{agent}:{exception_id} |
| plan.set / entitlement.override | platform, O | plan_code / limits | human_only | before/after limits | client uuid |

**Kernel-internal system operations (F7).** A few writes are triggered by flows that are not user-invocable actions — an anonymous share view, an SMTP delivery callback, async report completion, and auth invite acceptance. Rather than open a second write path (§5 ruling), these run *inside* the kernel as a defined, closed set of system operations with actor_type=system, audited and idempotent, but excluded from the public `POST /api/actions` dispatch surface: `share.view`, `message.delivery_update`, `report.complete`, `proof.upload_failed`, `person.link_auth`. They are catalogued in **Appendix B**; §20.3's audit-per-executed-action property test iterates them alongside the public catalog. §21.2's exact-match check is against the public catalog above; Appendix B is a named exemption, not a silent one.

## 6. Audit/event strategy

**Ruling [FIXED], answering open question 2:** relational current state plus an append-only `audit_events` table, written by the kernel **in the same transaction** as the mutation — an action that cannot write its audit event does not commit. This is not event sourcing. Strongest rejected alternative: full event sourcing with projections — it buys replay and temporal queries v1 does not need, and costs projection versioning and rebuild machinery that a solo operator and coding agents will mishandle under pilot pressure. Cost if wrong: the diff-carrying audit log already yields reconstruction-grade history; adding snapshots/replay later is additive work, not a rewrite.

Enforcement: on `audit_events`, `UPDATE`/`DELETE` privileges are revoked outright (append-only). On `execution_records` and `proofs`, `DELETE` is revoked and BEFORE triggers reject any `UPDATE` that (a) touches a non-status column, or (b) runs without the kernel-set session GUC `app.kernel_op` present — so only kernel-driven status/link transitions (record.verify/supersede/void, proof.complete_upload) pass and every fact column stays immutable (F4). The protected set is exactly {audit_events, execution_records, proofs} (F30); other naturally append-only tables (e.g. escalation_events) are guarded inside `core/domain` without triggers. `action_invocations` is deliberately outside this set: the kernel inserts it `pending` and updates it exactly once with the response envelope inside the same transaction (F30, F24). Corrections exist only as supersede/void actions — that is what makes the records billing-grade. audit_events links to action_invocations; share-link views are recorded by the kernel-internal `share.view` operation (Appendix B) as `share.viewed` audit events (token hash, IP hash, user agent) that also bump `report_shares.view_count`/`last_viewed_at` — not a separate table (F7). Retention: audit and verified records retained per workspace policy (default 24 months via `workspace.settings.retention_months`, configurable upward — App. A); person-PII erasure happens by pseudonymization so history and exports stay coherent. Audit reads are manager+ scoped.

Product and operational metrics are derived exclusively from `audit_events` and relational current state via `core/reads`; no separate analytics store, event pipeline, or third-party product-telemetry system exists in v1.

## 7. Multi-tenancy

Single Postgres, shared schema, answering open question 4 together with §9. [FIXED]: `workspace_id NOT NULL` on every tenant table; composite `(workspace_id, …)` indexes on all hot paths; Supabase Storage paths prefixed `ws/{workspace_id}/…`.

**Access-path ruling [FIXED]:** all reads and writes go server-side through `core` — no browser→Supabase direct queries, although that is idiomatic Supabase. Reason: two auth populations (Supabase-auth human actors and agent/system actors) and the kernel guarantees (entitlements, thresholds, audit-in-transaction, idempotency) cannot be enforced client-side; one gate beats two half-gates. RLS stays enabled on every table as a real backstop, not decoration: kernel DB traffic runs as a dedicated **`app_kernel` Postgres role that is *subject to* RLS** (it does not bypass it), setting `set_config('app.workspace_id', …, true)` per transaction so GUC-based policies compare each row's `workspace_id` to that setting. The Supabase **service role** — which bypasses RLS — is reserved for Storage and auth-admin calls only and never serves request-path kernel DB traffic (F13). Because the policies actually execute, a deliberate bug that drops the kernel's own workspace filter still returns zero cross-tenant rows; §20.4 proves isolation with RLS active, including that kernel-filter-bypass case. Consequence accepted: no Supabase Realtime in v1 — the board polls (60 s interval + on focus — F23) [FLEX, upgrade in §18]. Platform administration (us) is a distinct `platform` actor using explicit audited actions; no ad-hoc SQL against production, as a process rule.

## 8. Roles/permissions

| Role class | Seat | Surfaces | Summary of rights |
|---|---|---|---|
| owner | paid | dashboard | everything, incl. plan, action policies, pseudonymize |
| manager | paid | dashboard (+ capture) | clients/sites/commitments, reconcile, exceptions, reports/shares, approve proposals |
| supervisor | free | browser-first capture | day-pack for assigned sites (assignment = membership in `sites.settings.supervisor_person_ids`, F12), capture, close windows, raise/claim exceptions, execute approved recoveries; `(dashboard)` routes reject with a typed, catalog-translated rejection |
| worker | free | none in v1 (read-own later) | — |
| client_viewer | none | share pages | view one shared report |
| agent | n/a | action layer | per threshold classes (§5) |
| system | n/a | cron/detectors | deterministic actions only |

Authorization is a static role × action matrix in the code registry [FLEX → per-workspace matrix editor later; building it now is enterprise ceremony]. **Role inheritance (F6):** the catalog's actor columns list the *minimum* required role, not an exhaustive set — Owner inherits every Manager-level grant, and Manager inherits every Supervisor-level grant (including the capture routes of §10). Owner's "everything" above therefore stands exactly as written: an owner may run any operational action the catalog labels M or S (reconcile, share, export, capture, …). **Supervisor site scope (F12):** a supervisor's site set is exactly the sites whose `settings.supervisor_person_ids` include them (maintained by managers); that membership is the authz source deciding which day-packs they see and which windows they may close or raise exceptions on. Membership in `supervisor_person_ids` on a site in `draft` confers no visibility or authorization until activation. The §11 day-pack schema contains active sites only, consistent with DEC-015's resolved draft-site visibility ruling. Window-level assignments (A1) drive only board content and no-show detection, never authorization. Managers are workspace-wide. Client viewers are grants (report_shares), never seats — [FIXED], it is commercial structure.

## 9. Entitlements/pricing architecture

[FIXED] now, because retrofitting is expensive: workspace = billing entity. **Active site** = the metered value unit — `sites.status='active'`, with site.activate/site.archive as explicit audited human actions so the meter is legible to customers; sites in `draft` never count toward the active-site meter; windows also reference sites, so a usage-based formula (sites with windows in month) stays computable if the flag model proves wrong. Paid seats = persons with role_class in {owner, manager}; supervisors and workers are unlimited and free. Any future supervisor-pricing change is a `plans.limits` matter, not an authentication change. Enforcement lives **only** in the kernel's entitlement gate: actions declare needs (`gate: sites.active`, `gate: seats.manager` — which counts owner + manager persons together, consistent with "paid seats" above (F23), `gate: feature.agents`) and one resolver checks them against `plans.limits` — domain code never reads plan names, which is how plan logic stays out of domain logic (open question 4). Plans are a global config table, editable without deploy. Every limit rejection returns a typed, catalog-translated reason.

[FLEX]: tier names, prices, exact limits, trials, self-serve upgrades. v1 billing is manual invoicing (paid setup + monthly per plan) — no Stripe before payer 3; Stripe later slots in behind `plan_code` without schema change. Intended Vercel-style shape, all numbers [FLEX]: low-friction entry (1 active site, 1 manager), Team (per-active-site pricing, seat caps), Business (higher limits + agents + exports), Enterprise above thresholds (custom, SSO later).

## 10. Mobile/PWA capture model

Browser-first capture surface, German-first and designed for gloves-and-hallway use; the manifest and service worker ship, but installation as a PWA is optional. Home is the **Heute** board: today's ExecutionWindows for the supervisor's sites (the site scope of §8 / `sites.settings.supervisor_person_ids`, F12), grouped by site, each row showing frozen target and live status. Happy path ≤3 taps: window → confirm control → done. Confirm controls per type definition: headcount confirm ("Alle X anwesend"), per-person presence via tap-list with optional start/end times, output quantity via stepper/numpad, service checklist per frozen requirements. Camera-first proof capture where requirements demand it; batch confirm per site; inline exception raising ("Fehlt jemand?" → pick person → pre-filled no_show). Offline banner plus queued-count badge; the whole board renders from the cached day-pack whose exact active-site-only schema is fixed in §11. Managers use the responsive dashboard; capture routes work for them too. Native apps only if the PWA measurably fails at the pilot [FLEX] — answering the interface question without admitting bloat.

## 11. Offline/sync strategy

[FIXED] protocol, answering open question 6: capture writes are **queued action invocations** — payload + idempotency key + occurred_at stored in IndexedDB, flushed FIFO per browser instance on reconnect/background sync only after refreshing the Supabase session and completing §16's per-request membership validation. The outbox is partitioned by `(auth_user_id, workspace_id)` and only a live session matching both values may flush a partition. Refresh failure leaves its items queued behind an offline/re-login banner; another identity's partitions are inert, never auto-flushed or auto-purged, and purgeable only through explicit UI. Network failure leaves the item at the head and retries with backoff; `status=error` retries a bounded number of times and then parks; a typed rejection is deterministic, is never auto-retried, moves to a visible failed list with its catalog-translated reason, and does not block later items. Parked items are manually discardable and never silently dropped. Kernel idempotency makes flushes safely re-runnable; duplicates are impossible by construction. Facts are append-only (§4), so concurrent capture cannot conflict — two supervisors recording at one site both append, and window fulfillment is recomputed server-side. The few contended mutations use compare-and-set: window.close on an already-closed window returns current state plus a warning (attempt audited as a no-op; fulfillment is server-computed from verified records only, so the client counts summary never overrides it — F20); exception.claim CASes on owner and returns a conflict → UI refreshes. Clock skew: server stores received_at; occurred_at accepted within ±5 minutes, otherwise flagged in audit and surfaced in the reconcile view. Photos: blob stays local, the record syncs first with proof status=pending_upload, upload completes it — `proof.complete_upload` triggers a server-side re-encode + EXIF/GPS strip before the proof leaves `pending_upload` (F34); a missing_proof exception auto-raises if still pending beyond 24 h (default — App. A). Reads: the canonical day-pack is `{date, generated_at, sites: [{site_id, name, windows: [{window_id, commitment_id, title, type, starts_at, ends_at, target_qty, unit, requirements, fulfillment, status, assignments: [{person_id, display_name, status}]}]}], persons: [{person_id, display_name, role_class}], labels}`. Sites are active only and in the caller's F12 scope (managers: all active sites), ordered by name; windows are for the requested local date and ordered by starts_at. A scoped site with no windows remains as `windows: []`; zero scoped sites returns `sites: []`, never an error. The persons roster contains exactly persons referenced by assignments, and labels is the capture-namespace catalog in the person's locale. This is consistent with DEC-015's resolved rule that draft sites never appear in supervisor day-packs. The pack is fetched on open/focus and on the 60 s interval poll of §7 (F23) and cached; rendering it never requires a live token, and capture never requires a live read. No CRDTs, no generic sync engine. Strongest rejected alternative: offline-first sync databases (PowerSync/WatermelonDB class) — real capability, unjustified complexity for one write-mostly capture flow; cost if wrong: adopt one later *behind* the same invocation protocol.

## 12. Report/share-link architecture

Report generation is a pure function over verified data: params (client, period, sites) → immutable snapshot (JSON in Storage: closed windows only (F14) with frozen targets, verified records, proof index, exceptions summary, catalog version, and the explicit list of included window ids) → rendered branded Leistungsnachweis (print-CSS HTML; PDF via browser print in v1, server rendering later [FLEX]). Regeneration creates version n+1 and marks the prior report superseded — reports never mutate. A `ready` `leistungsnachweis` or `csv_export` permanently locks its included windows against reopen (digests never lock; `execution_windows.report_id` points at the latest such locking report and membership is recorded in the snapshot), §4 (F14). A **digest** is produced as `report.generate(type=digest)` (nat key per workspace+date) and then referenced by a `notify.send(sensitive=false)`; digests never lock windows and never appear in the client report inbox (F25). **CSV export contract v1** — produced only by `export.generate` (human_only), never by `report.generate` (F26); [the *existence and versioning* of the contract is FIXED; exact columns FLEX until payer 2 confirms]: **row grain = window × person** for presence-bearing types, with the person columns left empty on output/service rows (F27) — workspace, client, site, date, commitment id/title/type, window start/end, unit, target_qty, verified_qty, person display name, person start/end, person hours, record_ids, verified_by (the capturing actor, since capture auto-verifies — F32), exception_count, report_id, contract_version (=1).

Share links (open question 7): `/s/{token}` where the token is 128-bit random, stored **hashed**, with expiry (default 30 days), optional PIN, instant revocation, and per-view audit events; pages are read-only, server-rendered from the snapshot, session-free, rate-limited, `noindex`. Account-less client share pages are metadata-first by default: they show verified status, quantities, timestamps, proof counts/types, exceptions, and report/version context, but no proof thumbnails or images on initial load (F34). Original/full-size proof photos are not exposed on account-less share pages in v1. Later configurable thumbnail access may be added behind explicit manager/share policy and explicit viewer action, using private buckets plus short-TTL signed URLs minted per view (never public URLs), with the capture-time EXIF/GPS strip (§16, F34) still in force. Default template minimizes worker PII (first name + initial) [FLEX per workspace]. Strongest rejected alternative: client login accounts in v1 — friction kills the send-the-Leistungsnachweis moment; upgrade path: viewer accounts later reuse the same report grants.

## 13. Agent architecture

Agents are registered actor identities (`agent_code`) executing the same actions through the same kernel — no side APIs, no direct DB access. v1 ships two task agents plus one system digest job (jobs, not chat):

1. **Onboarding extractor** (workflow 4) — doc.upload → doc.extract_commitments: parses Einsatzvereinbarung / client order / scope documents via the Anthropic API and emits a batch of commitment.draft proposals with rationale, confidence, and source-span references. The manager reviews them in a proposal inbox (approve / edit-then-approve / reject per item); approval activates via the normal actions. Extraction is proposals-only by design — `commitment.draft` is proposal_gated for agent actors, so the extractor's drafts land as proposals and an agent never activates a commitment (F3).
2. **Recovery preparer** — on exception.raise, drafts 2–3 concrete RecoveryActions (recovery.propose, autonomous_safe because output is drafts): e.g., replacement candidates from recent site assignees, a client-notice draft, a make-up window suggestion. Approval and any external send remain human.
3. **Daily risk digest** — a morning **system cron (actor_type=system, Y), not an agent** (F1): `report.generate(type=digest)` over open exceptions, unstaffed windows, pending proofs, stale proposals, and stale drafts, then `notify.send`(sensitive=false, autonomous_safe) referencing that snapshot (F25).

Model routing is config per agent task [FLEX], following the tiered pattern: a small model for classification/routing, a mid model as the default worker, the top model reserved for low-confidence or high-stakes extractions. All calls are server-side; model name and token counts land in the audit extras.

**Promotion path [FIXED as mechanism]:** per (workspace, action_name, agent): a trailing window of ≥50 proposals with ≥95% approved-without-edit and zero attributable severity≥3 incidents makes the tuple promotion-eligible; the owner may then execute policy.promote_action (human-only, audited, with the reliability-stats snapshot stored), flipping proposal_gated → autonomous_safe for that tuple only. Any subsequent attributable incident auto-demotes (the system may always tighten). human_only actions are never promotable. **Attribution & auto-demotion (F31):** an exception is attributable to a (workspace, action_name, agent) tuple when its refs/window trace to an entity last mutated by that tuple within 7 days (App. A); `policy.demote_action` (system, Y) fires on any `exception.raise` of severity≥3 carrying that attribution, flipping the tuple back to proposal_gated, and a human may also demote. Because an approved proposal executes as the approving human with the originating `agent_code` recorded in audit extras (F2), both "approved-without-edit" rate and "attributable incident" are computable directly from the audit log. This is the structural distinction the frame demands: AgentProposal, human-confirmed action, autonomous-safe action, audit event, and consequence threshold are all first-class and measurable against the audit log.

## 14. Channel/integration architecture

Application/business outbound traffic goes through `outbound_messages` plus channel adapters; templates are catalog-keyed and localized. v1 adapters: **email** (Resend — escalations, digests, share notifications), **in-app** (badges/toasts from reads), and **web push** for escalation immediacy on supervisor browsers, committed for Phase 3. WhatsApp Business and Teams/M365 are later adapters behind the same table — pulled forward only if the pilot shows email + push failing the escalation loop; their cost is verification and operations overhead, not architecture. `sensitive=true` messages (anything client-facing beyond a share notification) require approved_by — agents draft, only humans send [FIXED]. Inbound channels: none in v1; upgrade path is inbound webhook → exception.raise proposals.

## 15. i18n/language strategy

Ruling, answering the i18n question: domain language, code, table and action names — English. Every user-facing string goes through a message catalog from day one (next-intl, ICU messages, English semantic keys). **de** is the completeness-enforced catalog (CI gate); **en** is maintained as the developer baseline. Status/enum labels, notification templates, report templates, and entitlement-rejection reasons are all catalog-keyed. Dates and numbers via Intl with the workspace timezone (Europe/Berlin default) and per-person locale. Business data (client/site names, notes) is never machine-translated. Ukrainian/Russian later = new catalogs plus a locale switch, no code change; no RTL requirement. [FIXED]: the catalog discipline itself — the cost of skipping it is retrofitting hundreds of hardcoded German strings while onboarding payer 2, which is why the lint gate exists from Phase 0.

## 16. Security/privacy/GDPR notes

Notes, not legal advice.

- Hosting and data: Supabase EU (Frankfurt) + Vercel fra1; Anthropic API data handling reviewed before the agent phase; processor list maintained for the AV-Vertrag (DPA) each workspace signs at setup.
- Data minimization: workers need a display name only and no account in v1; supervisors require an invited email as their login identity; phone remains optional. No GPS, no geofencing, no continuous tracking — the model is **supervisor-attested delivery verification at site level**, which is the honest Betriebsrat position and a design fact, not a toggle. Later worker read-own access through the same invite mechanism increases transparency further.
- Photos: in-app camera capture; `proof.complete_upload` re-encodes and strips EXIF/GPS server-side before the proof leaves `pending_upload` (F34); capture UI copy states the default policy "work results, not people"; private buckets, short-TTL signed URLs support only future/explicit thumbnail reveals on share pages (§12).
- Auth (open question 5): owners, managers, and supervisors use Supabase Auth with email magic link and Google OAuth in v1 (magic-link email is sent by Supabase Auth SMTP configured to route through Resend, not the outbound_messages adapter — F23), resolved to a persons row via `persons.auth_user_id` with the active workspace explicit in the session and one auth identity permitted to hold roles in multiple workspaces (F11). `persons.auth_user_id` is populated only at invite acceptance (DEC-010/DEC-012): `person.invite` (O, M, human_only) issues a Supabase Auth invite for an active owner/manager/supervisor person holding an email and no linked identity, and the kernel-internal `person.link_auth` operation (Appendix B) writes `auth_user_id` on acceptance only after verifying that the accepting identity's email equals the email to which the latest invite was issued — email-match auto-linking remains rejected, since it would turn `person.update` into an access grant. Google acceptance uses only Supabase's provider-verified email, requires `email_verified=true`, and compares it case-normalized to the case-normalized invited email. Sessions are established only for persons with `status='active'` and `role_class` in {owner, manager, supervisor}; every other resolution — zero qualifying memberships, an inactive person, or a worker holding an email — returns one typed, catalog-translated rejection. Supervisor sessions may reach only `(capture)` routes; `(dashboard)` routes return a typed, catalog-translated rejection. The Supabase session carries identity only: the selected `workspace_id` lives in its own httpOnly cookie as selection intent, never authority, and every request re-resolves (auth_user_id, workspace_id) to an active, eligible persons row before the kernel sets the per-transaction `app.workspace_id` GUC (§7) — so deactivation, pseudonymization, and role changes take effect on the next request, with no stale-claim window. Workspace switching is an explicit endpoint running the identical validation; the session-establishment route returns the identity's qualifying memberships (workspace id and display name only) so an F11 multi-workspace identity can select one. DEC-011's membership function retains its existing RLS-safe SECURITY DEFINER and return-field contract while widening its filter to active persons with role_class in {owner, manager, supervisor} and active workspaces. Apple is triggered only by iPhone-holding supervisors at the pilot plus an available developer account; Microsoft/Entra only when named by an Enterprise-tier customer under §9's SSO reservation; passkeys only post-v1 as a convenience credential on existing accounts. Passwords, SMS OTP, and long-tail social providers are excluded and require a new decision to reopen. SMS OTP remains rejected because of delivery cost, phone-number churn in frontline populations, and worse data minimization. A provider enters only when a named user group demonstrably holds that account type and the phase touches its login surface. Workers remain outside the account system in v1.
- Erasure: person.pseudonymize replaces PII while immutable records and exports stay coherent (legal-basis note stored in audit). Retention windows configurable per workspace; audit retained at least as long as records.
- Application: CSP; rate limits on `/s/*` and authentication endpoints; secrets server-only via Vercel env; cron endpoints require CRON_SECRET; share tokens exist only as hashes.

## 17. What to build first

The action kernel with audit, idempotency, and RLS — then the daily board and capture on top of it, and nothing else. Every later feature (exceptions, reports, agents, entitlements) is only credible because every fact already enters through one audited, idempotent, tenant-safe gate; building the board first without the kernel would create a second write path that every later phase would have to hunt down and kill. Phase 1 ends with real supervisors confirming real windows at the pilot's sites.

## 18. What not to build yet (deferred upgrade path in one line each)

- Stripe / self-serve billing → plans are already keyed by plan_code; bolt checkout on later.
- Public API keys / partner API → publish the existing exported action/read JSON Schemas behind an api_keys table.
- MCP server → thin mapping of tools→actions and resources→reads over the same registry.
- WhatsApp / Teams / M365 adapters → new adapter behind outbound_messages.
- Native iOS/Android → wrap the PWA (Capacitor) only on measured PWA failure.
- Realtime board updates → swap polling reads for Supabase Realtime channels.
- Worker read-own access → reuse the person invite/link mechanism plus a filtered day-pack read.
- PIN/passkey device binding → reserved `auth_devices` and `persons.pin_hash`; reopening this path requires a new decision.
- Custom commitment-type builder UI → move type definitions from code registry to DB registry.
- Per-workspace permission editor → the role×action matrix is already data-shaped in the registry.
- Server-side PDF rendering → replace print-CSS with a headless renderer behind report.generate.
- Cleaning/facility vertical (incl. Objektkontrolle) → second template bundle over unchanged primitives.
- Metrics read (exception MTTR, capture latency, automation index) → one new read over `audit_events`; candidate Phase 6.

## 19. Implementation phases

**Module/repo map** — one Next.js app, `core` as an internal path-aliased package; no monorepo tooling.

```
repo/
  app/                      # Next.js App Router — thin, no business logic
    (dashboard)/            # manager web UI
    (capture)/              # supervisor PWA routes
    s/[token]/              # public share views
    api/actions/            # single action dispatch endpoint
    api/reads/[name]/       # read endpoints
    api/cron/               # Vercel cron entrypoints (CRON_SECRET)
  core/
    actions/                # registry + kernel (authz, entitlements, thresholds, idempotency, audit)
    domain/                 # entities, state machines, commitment-types/, zod schemas
    reads/                  # query layer (day-pack, lists, report data)
    agents/                 # extractor, recovery-prep, digest; model routing config
    reports/                # snapshot builders, templates, csv contract
    notify/                 # outbound_messages + channel adapters
    i18n/                   # de.json (CI-complete), en.json
    db/                     # drizzle schema, client, GUC helper — the only db import site
  db/migrations/            # sequential SQL, checked in
  db/seed/                  # fixture workspace "Demo GmbH"; grown per phase via kernel action replay (DEC-004)
  tests/
    actions/                # kernel integration tests against local Supabase
    rls/                    # tenancy isolation tests
    e2e/                    # Playwright capture happy path incl. offline
  public/                   # PWA manifest, icons, service worker assets
```

Touch rules: one coding agent at a time. **PR granularity (F8):** per AGENTS.md the unit of work and of the PR is a vertical slice (schema/handler/logic + tests + audit, tests green); `phase-N` is a tracking milestone / integration label spanning that phase's slices, not a single mega-PR, and PROGRESS.md is updated per slice — where this conflicts with the older "one PR per phase" phrasing, AGENTS.md wins. The **full v1 schema ships in Phase 0 migrations** — schema is cheap, later migrations are agent risk; later phases add code, not tables [FIXED]. After Phase 0 review, frozen paths are the **kernel pipeline modules** within `core/actions/` (dispatch, authz, entitlement, threshold, idempotency, audit) — *not* the registry's per-action definition files, which each later phase appends to — plus `core/db/`, `db/migrations/`, and RLS policies; from each phase's review onward, that phase's `core/domain` state machines freeze too. Each phase brief names its frozen files explicitly (F33). Frozen paths change only via a CHANGE-REQUEST section in a PR, never silently. **Seed data ruling [FIXED] (DEC-004):** `db/seed/` fixtures are produced exclusively by replaying kernel action invocations with deterministic idempotency keys — never direct SQL — so seed rows carry the same audit trail, state-machine validation, and production-path parity as every other write; seed content is therefore phase-gated by action availability.

**Phase 0 — Foundation (week 1).** Scope: repo per map; CI (typecheck, lint including no-hardcoded-strings and no-db-import-outside-core rules, tests); local Supabase; migrations = full §3 schema + RLS policies + insert-only triggers, plus DEC-013's authorized widening of DEC-011's membership function; kernel with authz, entitlements-as-noop-unlimited, thresholds, validation, transaction+audit, idempotency; auth (owner/manager/supervisor email magic link and Google OAuth, invite/link, per-request role resolution, and capture-surface routing); seed fixture — workspace/persons/clients/sites only, via kernel action replay (commitment fixtures move to Phase 1, DEC-004). Entities: all (schema); active code for workspace/person/client/site, with device credentials reserved and unused. Actions: that set plus person.invite; device actions are excluded from v1. Reads: a minimal authenticated `me` read (empty day-pack shell) so an authenticated supervisor session can return a read response (F29). UI: login + bare authenticated and capture shells. Tests: idempotency replay, RLS isolation (incl. the kernel-filter-bypass case, §7/F13), audit-per-action property test, invited-supervisor magic-link and Google acceptance, capture routing, and immediate deactivation/role-change enforcement. **Done means (agent-verifiable):** §20 items 1–7 and 12 green in CI; the `me` read returns for an authenticated supervisor session; §21.2 exact-match is green without device actions. **Operator-accepted (pilot sign-off, not gating the PR):** an invited pilot supervisor signs in on a real phone and reaches the capture shell (F28).

**Phase 1 — Board + capture live (weeks 2–3).** Scope: commitment CRUD (manual forms, rrule presets), window.generate cron (rolling 7-day horizon, timezone-correct), day-pack read, browser-first Heute board with optional PWA installation, capture (presence, coverage_confirm, output, service_confirmation, note), proofs with deferred upload, offline outbox, batch confirm, assignment quick-set, German catalog complete for these surfaces; seed extension — Demo GmbH's commitment/window fixtures, added now via commitment.draft/activate and window.generate replay (DEC-004). Actions: commitment.* (incl. auto-complete on valid_to), window.generate/open/close/reconcile/reopen, assignment.*, record.capture/verify/supersede/void, proof.* (F19). UI: board, window detail, capture controls, manager commitment forms. Tests: e2e capture happy path including airplane-mode queue/sync; window-freeze test; fulfillment unit tests per type definition. **Done means (agent-verifiable):** e2e records a window offline→synced in ≤3 taps measured from the Heute board to done; tomorrow's board auto-generates in the seed; zero duplicate records under forced retry. **Operator-accepted:** a pilot supervisor does the same on their own phone at a real site (F28).

**Phase 2 — Exceptions/escalation/recovery (weeks 3–5).** Scope: detectors (missed window, shortfall on close, missing_proof timeout, unstaffed window at T-minus), manual raise incl. client_complaint, claim/assign with CAS, recovery actions, escalation rules + escalation.tick cron, email + in-app notifications, exception views in PWA and dashboard; actions exception.raise/claim/assign/cancel/close, recovery.propose/approve/start/complete/cancel, escalation.tick/acknowledge, and notify.send (required by this phase's email + in-app notification scope and done-means; Phase 4's digest reuses notify.send — DEC-001) per the §4 detector mapping and RecoveryAction lifecycle (F19). Tests: simulated no-show walks open→owned→recovering→resolved→closed with escalation firing on a breached due_at; CAS conflict test. **Done means (agent-verifiable):** every shortfall/missed window in seed scenarios yields exactly one **open** exception, and claiming it walks the full lifecycle (F16); the escalation email is emitted to the test mail sink; closure requires ≥1 recovery in `done`. **Operator-accepted:** the escalation email arrives in a real inbox (F28).

**Phase 3 — Reports, export, shares (weeks 5–6).** Scope: report.generate (Leistungsnachweis snapshot + branded print view), CSV export per contract, report_shares (token/PIN/expiry/revoke/view-audit), public share page, manager report inbox; committed web-push delivery for escalation immediacy on supervisor browsers. Tests: snapshot immutability and versioning; revoked/expired token → 404; CSV column-contract test (window×person grain, F27). **Done means (agent-verifiable):** a generated branded link renders only verified data from the snapshot; revocation makes it 404 live; the CSV matches the contract and parses into a spreadsheet fixture without manual edits. **Operator-accepted:** the pilot client opens the link and the export imports into the pilot's real invoicing spreadsheet (F28).

**Phase 4 — Agents (weeks 6–8).** Scope: agent actor plumbing + proposal inbox UI; onboarding extractor (PDF/DOCX → commitment proposals with source spans); recovery preparer; daily digest as a system cron (F1); model routing config; token/cost logging; actions proposal.approve/reject/expire/supersede and policy.demote_action (F19, F31). Tests: registry-wide test that an agent invoking any proposal_gated action mutates nothing; extractor golden-file test on two sample Einsatzvereinbarungen; approve-with-edit stores diff + invocation_id + originating agent_code. **Done means (agent-verifiable):** a golden fixture document becomes reviewed→activated commitments producing next-day windows in the seed; no agent mutation exists outside the proposal or autonomous_safe classification (registry-wide test). **Operator-accepted:** a real pilot document runs the same path end-to-end (F28).

**Phase 5 — Entitlements + payer-2 readiness (weeks 8–10).** Scope: plans populated; gates enforced (active sites, manager seats counting owner+manager per §9, feature.agents) with typed translated rejections; workspace-creation flow + onboarding checklist; promotion-path stats view (read); actions plan.set, policy.promote_action, and entitlement.override (F19, DEC-002); hardening (rate limits, error/empty states); ops runbook. Tests: limit-rejection tests; new-workspace smoke test. **Done means (agent-verifiable):** creating a site or seat over limit blocks with a translated reason; the new-workspace smoke test provisions a second workspace end-to-end. **Operator-accepted:** a second unrelated workspace is onboarded in ≤1 day using only the product plus the checklist (F28).

**Per-phase §20 applicability (F5).** Each phase's CI gates only the §20 criteria whose features exist by then; the rest are N/A until their phase: **P0** → 1–7, 12; **P1** → 1–8, 11, 12; **P2** → 1–8, 11, 12; **P3** → 1–8, 10, 11, 12; **P4** → 1–12; **P5** → 1–12. "The §20 criteria applicable to this phase" in the handoff DoD means exactly this subset.

**Handoff block — verbatim, prepended to every phase brief:**

> You are the implementing coding agent for the ops control plane repo. Context: a multi-tenant operations control plane for distributed frontline commitments; the primitives, state machines, actions, schema, and boundaries are defined in `ARCHITECTURE.md` at repo root — that document is binding. You implement the current phase only, as scoped in this brief.
> Constraints: (1) Every mutation goes through the action kernel — never write to the database or Storage outside `core`. (2) No schema changes; if you believe one is required, stop and output a CHANGE-REQUEST section instead of code. (3) No new dependencies without listing each with a reason in the PR description. (4) All user-facing strings via the i18n catalog; German must be complete for every shipped surface. (5) Do not modify frozen paths listed in this brief. (6) No business logic in `app/` — components call actions and reads only. (7) Implement state transitions exactly as specified; do not invent states or transitions. (8) Do not build anything from the exclusions list or the not-yet list, even if convenient.
> Definition of done: this phase's **agent-verifiable** "done means" plus the §20 criteria applicable to this phase (the per-phase §20 map above, F5) passing in CI, with typecheck and lint clean; operator-accepted items are signed off by the operator before phase close and do not gate the PR (F28).
> Report back: open your slice PR(s) under the `phase-N` milestone (F8), each containing (a) a summary mapping what was built to the phase scope list, (b) test evidence — CI link and a recording for capture flows, (c) a DEVIATIONS section listing every divergence from ARCHITECTURE.md with reasons, (d) an OPEN-QUESTIONS section, maximum five, only questions whose answers change implementation. Do not merge; the reviewer merges.

## 20. Acceptance criteria for coding agents (global, binary)

1. Unknown action name at dispatch → typed rejection; every registered action has a Zod input schema.
2. Replaying an invocation with the same idempotency key produces one action_invocations row, one execution, and a byte-identical response (test).
3. A property test iterates the registry: every executed action yields ≥1 audit_event committed in the same transaction.
4. RLS tests: a workspace-A actor reading or writing workspace-B rows gets zero rows / denial, on ≥3 representative tables plus a Storage-path check.
5. Static gates in CI: no Supabase/db client import outside `core/db`; no `core/db` import inside `app/`.
6. On execution_records/proofs, any non-kernel UPDATE (one missing the kernel-set `app.kernel_op` GUC) or any UPDATE touching a fact (non-status) column raises; audit_events rejects all UPDATE/DELETE (SQL test); corrections exist only via supersede/void actions (F4).
7. i18n gate: a hardcoded user-facing string fails lint; the de.json completeness check passes.
8. E2E: airplane-mode capture queues; on reconnect the client refreshes the Supabase session and completes per-request membership validation before flushing; sync completes with zero duplicates after forced retry.
9. An agent actor invoking any proposal_gated action creates a proposal and performs no mutation (registry-wide test).
10. A revoked or expired share token returns 404; share tokens exist only as hashes in the database.
11. Editing an active commitment leaves already-generated windows' frozen targets untouched (test).
12. Fresh clone: migrations apply on an empty database, seed runs, typecheck + lint + tests green — via one documented command chain.

## 21. Review checklist for Fable as later judge

1. Repo tree matches the §19 module map; no stray top-level directories.
2. Action registry names match the §5 catalog exactly for the actions in scope through the current phase (full catalog match at Phase 5); the Appendix B kernel-internal ops are the only non-catalog kernel writers; additions/removals appear in PR DEVIATIONS (F19, F7).
3. Kernel pipeline order in code = authorize → entitlement → threshold → validate → transaction(execute + audit) → persist result.
4. All primary keys are app-generated UUIDv7 — except global config tables (`plans`, which keep a text `code` PK, F9); created_at present on every table.
5. SQL evidence attached: every tenant table has workspace_id NOT NULL, RLS enabled, and a (workspace_id, …) index.
6. Immutability enforcement present on exactly {audit_events (append-only), execution_records, proofs (BEFORE triggers rejecting non-kernel or fact-column UPDATE per F4)}; action_invocations is inserted pending and updated once with the response inside the same kernel transaction (F30).
7. Unique (workspace_id, idempotency_key) index exists; cron actions use deterministic natural keys.
8. Status transitions occur only in `core/domain` modules (status writes elsewhere = fail): the five §4 machines are formal transition tables; other status-bearing tables use a lighter guard-and-set, still inside core/domain — judged at module level, not per-table (F21).
9. execution_windows rows carry frozen target/requirements; the freeze test exists and passes.
10. Supervisor auth: invited supervisors complete email-magic-link and Google acceptance, reach only `(capture)` routes, receive a typed rejection from `(dashboard)` routes, and deactivation or role change takes effect on the next request.
11. Share pages are server-rendered from the snapshot; token hashed; rate limit present; noindex set.
12. PWA: manifest, service worker, IndexedDB outbox, day-pack read all present; offline e2e recording attached.
13. German catalog complete for shipped surfaces; the lint gate is active in CI config.
14. CSV export matches the contract columns and order; contract_version emitted.
15. Agent calls route through the kernel with actor_type=agent; the Anthropic key is server-only; model + token counts logged.
16. proposal.approve stores invocation_id, the edited-input diff, and the originating agent_code; the approving human is the recorded actor and authz + entitlement are re-checked at approval (F2).
17. Cron routes verify CRON_SECRET; every cron action is idempotent by natural key.
18. Entitlement gates are declared on actions and resolved centrally; a limit rejection is typed and translated.
19. Forbidden-scope grep: no pay/invoice calculation, rostering, chat, or form-builder code anywhere.
20. Every PR contains DEVIATIONS and OPEN-QUESTIONS sections; frozen paths untouched or explicitly flagged via CHANGE-REQUEST.

## Appendix A — Operational defaults (F23, F16, F31)

Consolidated home for the constants referenced across §§4–16, so no phase has to invent a number. Each value is workspace-tunable and [FLEX] unless the owning section marks it FIXED; where an entry names a settings key it lives under `workspaces.settings`.

| Constant | Default | Home / key | Ref |
|---|---|---|---|
| Window grace before `missed` | 30 min | type-def / workspace | §4, F23 |
| missing_proof timeout | 24 h | workspace | §11, F23 |
| Unstaffed-window detector T-minus | 60 min | workspace | §19 P2, F23 |
| AgentProposal TTL (`expires_at`) | 72 h | workspace | §4, F23 |
| Exception `due_at` | raise + per-severity offset | computed | §4, F16/F23 |
| Per-severity due offsets | sev4 30 min · sev3 2 h · sev2 8 h · sev1 24 h | code default | §4, F16 |
| Escalation `after_min` zero-point | the due_at breach | code | §4, F23 |
| Board polling interval | 60 s (+ on focus) | code | §7/§11, F23 |
| Retention | 24 months | `retention_months` | §6, F23 |
| `seats.manager` counting | owner + manager | resolver | §9, F23 |
| "Open windows" (commitment.archive) | any window not in `closed` | code | §4, F23 |
| Stale-draft digest threshold | 30 days | `workspaces.settings.stale_draft_site_days` | §13, DEC-015 |
| Supabase Auth email transport | Supabase Auth SMTP → Resend | infra | §16, F23 |
| Agent-incident attribution window | 7 days | code | §13, F31 |

Values already fixed in-section and not re-litigated here: share-link expiry 30 days (§12), exception auto-close 7 days (§4), window auto-reconcile 48 h (§4), clock-skew tolerance ±5 min (§11).

## Appendix B — Kernel-internal system operations (F7)

These run inside the kernel with actor_type=system — audited and idempotent like any action — but are **not** on the public `POST /api/actions` surface and are not user-invocable; they exist so non-user-triggered writes never open a second write path (§5). §20.3's audit-per-executed-action property test iterates them alongside the public catalog; §21.2 treats them as a named (not silent) exemption from the §5 catalog match.

| Operation | Trigger | Writes | Idempotency key |
|---|---|---|---|
| share.view | anonymous GET on `/s/{token}` | `share.viewed` audit event; `report_shares.view_count`/`last_viewed_at` | nat: share.view:{share_id}:{request_id} |
| message.delivery_update | channel / SMTP delivery callback | `outbound_messages.attempts`/`sent_at`/`status` | nat: msg.delivery:{message_id}:{event} |
| report.complete | async report generation finishes | `reports.status` generating→ready/failed | nat: report.complete:{report_id} |
| proof.upload_failed | Storage upload-failure signal | `proofs.status` → failed | nat: proof.fail:{proof_id} |
| person.link_auth | Supabase Auth invite acceptance | `persons.auth_user_id` (only if the accepting identity's email still equals `persons.email`) | nat: person.link:{person_id}:{auth_user_id} |
