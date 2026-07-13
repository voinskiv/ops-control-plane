# Decisions Log
Append-only. Each entry tracks one CHANGE-REQUEST raised during implementation.
Per AGENTS.md this file is an extension of ARCHITECTURE.md; entries are binding alongside it.

## Format
### DEC-<NNN> — <date> — <one-line summary>
- Status: OPEN | RESOLVED
- Raised by: <slice/task>
- Question:
- Resolution:
- Architecture impact: <none | amends section X>

An entry is created with Status: OPEN and Question filled in at the moment a
CHANGE-REQUEST is emitted — before any code the answer could change is
written. Resolution and the flip to Status: RESOLVED are filled in only from
a human's answer (an agent may transcribe it verbatim but must name the
approver, and never authors a Resolution itself). Any OPEN entry blocks its
scope for every session until resolved.

---
(log starts below)

### DEC-001 — 2026-07-05 — escalation.tick, escalation.acknowledge, notify.send assigned to Phase 2
- Raised by: PROGRESS.md bootstrap (Bootstrap ambiguities; SLICE-026/SLICE-027)
- Question: Phase 2's F19 action list omitted escalation.tick, escalation.acknowledge, and notify.send, even though Phase 2's scope ("escalation rules + escalation.tick cron, email + in-app notifications") and done-means ("the escalation email is emitted to the test mail sink") require them, leaving notify.send implicitly in Phase 4 via the digest.
- Resolution: Clerical omission. All three actions ship in Phase 2; §19 Phase 2 action list amended. Phase 4's daily digest reuses notify.send, no Phase 4 change.
- Architecture impact: amends §19 Phase 2 action list (clerical; no product/domain change)

### DEC-002 — 2026-07-05 — plan.set assigned to Phase 5
- Raised by: PROGRESS.md bootstrap (Bootstrap ambiguities; SLICE-042)
- Question: plan.set has a §5 catalog row but appeared in no phase's action list; Phase 5 named only policy.promote_action and entitlement.override.
- Resolution: Clerical omission. plan.set ships in Phase 5 alongside entitlement.override — they share one catalog row (same actors, threshold, audit extras) and Phase 5 owns "plans populated" plus entitlement enforcement; §19 Phase 5 action list amended.
- Architecture impact: amends §19 Phase 5 action list (clerical; no product/domain change)

### DEC-003 — 2026-07-05 — escalation_rule.create/update and escalation_rule.enable/disable added to §5 catalog
- Raised by: PROGRESS.md bootstrap ambiguities (item 1); CHANGE-REQUEST issued and approved
- Question: No §5 catalog action existed to create, edit, enable, or disable escalation_rules, despite Phase 2 requiring them and §21.2 requiring an exact catalog match against the registry.
- Resolution: Add `escalation_rule.create / update` (O, M, proposal_gated, steps diff in audit) and `escalation_rule.enable` (O, M, proposal_gated) / `escalation_rule.disable` (O, M, human_only, reason required) to the §5 catalog, following the client.*/site.activate row pattern. Disable is human_only because silencing escalation reduces alerting safety — the system may only tighten, never loosen; disabled rules are excluded from escalation.tick matching without retracting already-fired escalation_events.
- Architecture impact: amends §5 action catalog (adds three rows)

### DEC-004 — 2026-07-05 — Seed data writes only via kernel action replay; commitment fixtures move Phase 0 → Phase 1
- Raised by: PROGRESS.md bootstrap ambiguities (item 2); CHANGE-REQUEST issued and approved
- Question: Whether `db/seed/` fixtures may write directly to the database or must replay kernel action invocations like every other write, per the single-write-path ruling (§5, §6).
- Resolution: Seed data is produced exclusively by replaying kernel action invocations with deterministic idempotency keys — no direct SQL — so fixtures carry the same audit trail and state-machine validation as production data. Seed content is phase-gated by action availability: Phase 0's seed covers workspace/persons/clients/sites/devices only; Demo GmbH's commitment/window fixtures move to a Phase 1 seed extension, once commitment.draft/activate and window.generate exist.
- Architecture impact: amends §19 (Touch rules seed ruling, repo map `db/seed` comment, Phase 0 scope, Phase 1 scope)

### DEC-005 — 2026-07-05 — Idempotency scoping for platform-actor workspace.create (tenant-root bootstrap)
- Status: RESOLVED
- Raised by: Action-kernel slice (SLICE-003 + representative action workspace.create), structural-pattern proposal stage — no code written
- Question: §5 fixes idempotency as unique (workspace_id, idempotency_key) with replay matched on that pair, but a platform-actor workspace.create invocation has no workspace_id before execution — the action creates the tenant root. How is replay detected and the action_invocations row scoped for this bootstrap case? Options: (A) kernel-internal replay lookup for platform-actor invocations by (idempotency_key, actor_type=platform) with input_hash comparison, row keeps the created workspace's id, plus a partial unique index enforcing global key uniqueness for platform invocations only; (B) the input carries the app-generated UUIDv7 workspace id so the (workspace_id, idempotency_key) pair is known pre-execution — a visible change to the §5 catalog input row; (C) a dedicated platform workspace row scopes all platform-actor invocations — a synthetic tenant that RLS and reads must special-case permanently.
- Resolution: Option A — "kernel-internal replay lookup for platform-actor invocations, scoped by (idempotency_key, actor_type=platform), with input_hash comparison and a partial unique index; §5's (workspace_id, idempotency_key) scoping continues to govern every non-platform action unchanged." Approver's rationale: A is purely internal to the kernel — no input schema changes, nothing any caller can observe differently; B would widen the §5 catalog input while §5 idempotency is marked [FIXED], so B reopens a locked ruling rather than implementing one; C creates a permanent synthetic-tenant special case in RLS and reporting to solve a one-time bootstrap problem — worst cost-to-benefit of the three. Approver's implementation note: the migration adding the partial unique index lands in the PR that creates action_invocations (SLICE-002), not the kernel PR. Approved by: Vitali Voinski (operator), 2026-07-05; transcribed by the implementing agent.
- Architecture impact: none — kernel-internal; §5 catalog and non-platform idempotency scoping unchanged

### DEC-006 — 2026-07-05 — Where do §5 audit extras live in audit_events?
- Status: RESOLVED
- Raised by: SLICE-002 (schema authoring). Blocks the audit-extras write path
  (SLICE-003's kernel audit writer and every action slice with a non-empty
  Audit-extras column, starting with SLICE-005's plan snapshot) — not
  SLICE-002 itself, whose schema is valid under every option below.
- Question: §5 fixes the audit payload ("Audit payload always includes
  invocation_id, actor, entity refs, and before/after diff; the Audit-extras
  column lists additions") and nearly every catalog row names extras (reason,
  plan snapshot, code hash, fulfillment calculation, model + token counts, …),
  but §3's audit_events row defines no storage for them (invocation_id?,
  actor_type, actor_id?, action, entity_type, entity_id, before?, after?, at).
  Where do audit extras live?
  Options considered: (A) add `extras jsonb?` to audit_events — dedicated
  storage keeping before/after as pure state diffs; one additive migration; a
  reviewer picks this if §6's reconstruction-grade history should keep diffs
  and extras separable. (B) fold extras into `after` under a reserved key — no
  schema change; a reviewer picks this if §3's field list must stay literally
  closed, accepting that before/after stops being a pure state diff. (C) store
  extras only in action_invocations.result — no audit_events change; a
  reviewer picks this if the response envelope is considered the audit extras
  record, accepting extras lose per-event linkage and the §6 append-only
  guarantee (action_invocations is updatable by design, F30).
  Smallest-safe default: proceed with audit_events exactly per §3 — every
  option lands additively before the first extras writer exists.
  Why this needs human sign-off: AUDIT model and logged fields (AGENTS.md
  AMBIGUITY list); if the default were wrong the audit log would either lose
  catalog-mandated evidence or corrupt diff semantics on a billing-grade trail.
- Resolution: Option A — add `extras jsonb` (nullable) to audit_events;
  before/after stay pure entity-state diffs and the §5 Audit-extras payloads
  live in the dedicated column, covered automatically by the append-only
  privilege revocation (§6). Rationale as approved: B makes `after` ≠
  post-mutation state, so every consumer (F31 attribution, the Phase 5
  promotion-stats read, reconstruction) inherits a strip-the-reserved-key
  parsing hazard; C stores tamper-relevant evidence (GDPR basis note, reasons,
  reliability snapshots) in a table that is updatable by design (F30) and
  loses per-event granularity (one invocation can emit several audit events,
  F2). Cost if wrong: a redundant nullable column. Migration lands in
  SLICE-003. Approved by: Vitali Voinski (operator), 2026-07-06; proposal
  authored and transcribed by the implementing agent.
- Architecture impact: amends the §3 audit_events row (adds `extras jsonb?`);
  amendment applied to ARCHITECTURE.md by the operator

### DEC-007 — 2026-07-05 — How is the platform actor represented in audit_events?
- Status: RESOLVED
- Raised by: SLICE-002 (schema authoring). Blocks SLICE-005 (workspace.create
  writes an audit event as the platform actor) and later plan.set /
  entitlement.override — not SLICE-002 itself.
- Question: §5/§7 define `platform` as a distinct audited actor
  (workspace.create, plan.set, entitlement.override) and DEC-005 fixes
  actor_type='platform' rows in action_invocations, but §3 fixes
  audit_events.actor_type as enum(person, agent, system). How is a
  platform-actor action attributed in the audit log?
  Options considered: (A) add 'platform' to the audit actor_type enum —
  additive ALTER TYPE; a reviewer picks this for faithful attribution
  matching action_invocations. (B) audit platform actions as
  actor_type=system with a platform marker in extras — no enum change; a
  reviewer picks this if §3's enum must stay closed, accepting 'system'
  (defined as cron/detectors, §2) is overloaded and the marker depends on
  DEC-006. (C) audit as person with a synthetic actor_id — rejected shape:
  misattribution.
  Smallest-safe default: proceed with §3's exact 3-value enum on audit_events
  and a separate 4-value invocation_actor_type on action_invocations (DEC-005
  requires 'platform' there) — every option remains additively implementable.
  Why this needs human sign-off: AUDIT model / stored data formats (AGENTS.md
  AMBIGUITY list); wrong attribution of platform actions on an append-only
  trail cannot be corrected retroactively.
- Resolution: Option A — `ALTER TYPE actor_type ADD VALUE 'platform'`;
  audit_events attributes platform actions faithfully, matching the
  actor_type='platform' rows action_invocations already carries (DEC-005).
  The invocation_actor_type enum stays a separate type even though the value
  sets now converge (independent evolution, no column-type migration churn).
  Locked-ruling check (verified before transcription): §3 places no [FIXED]
  marker on the audit_events row or its enum — §3's only [FIXED] covers the
  commitment-type column/JSONB split; §6's [FIXED] ruling (append-only
  audit_events written in the same transaction) is not reopened by an enum
  value; §19's "later phases add code, not tables [FIXED]" concerns new
  tables and this lands within Phase 0. This is therefore an additive
  amendment to the §3 table row, not a change to a locked ruling — unlike
  DEC-005's rejected Option B, which would have widened §5's [FIXED]
  idempotency contract. Rationale as approved: §7 already names platform "a
  distinct `platform` actor using explicit audited actions"; auditing it as
  `system` overloads a value §2 defines as cron/detectors, makes the most
  security-relevant events the only ones needing jsonb-marker parsing to
  attribute, couples DEC-007 to DEC-006's column, and creates a permanent
  platform↔system vocabulary mismatch across the audit_events.invocation_id
  join. Migration lands in SLICE-003. Approved by: Vitali Voinski (operator),
  2026-07-06; proposal authored and transcribed by the implementing agent.
- Architecture impact: amends the §3 audit_events row (actor_type enum gains
  'platform'); amendment applied to ARCHITECTURE.md by the operator

### DEC-008 — 2026-07-08 — SLICE-006 person action scope, input contract, and erasure recipe
- Status: RESOLVED
- Raised by: SLICE-006 implementation stop (Codex CHANGE-REQUEST)
- Question: SLICE-006 asks for `person.create`, `person.update`,
  `person.deactivate`, and `person.pseudonymize`, but PROGRESS.md still has a
  Bootstrap ambiguities note marked "confirm" for whether Phase 0 includes the
  full catalog set for person actions, including `person.pseudonymize`.
  Additionally, §5 names `person.create / person.update` input as
  "role_class, name, contact" without fixing how `person.update` identifies
  the target person, whether update fields are full-replacement or partial, how
  `contact` maps to §3's `email?` / `phone?` columns, whether locale is part of
  the action input, and what exact PII replacement/nulling recipe plus GDPR
  basis audit payload `person.pseudonymize` must use.
- Resolution:
  1. Scope confirmed: Phase 0 / SLICE-006 implements all four person actions
     (create, update, deactivate, pseudonymize). This resolves the person
     portion of the Bootstrap ambiguity only; the site.activate/archive
     portion remains open for SLICE-007.
  2. §5 input "contact" is shorthand. Public inputs are flat fields mapping
     1:1 to §3 columns; no nested contact object.
  3. person.create input: display_name (1–200, required), role_class
     (enum, required), email? (trimmed, max 254), phone? (trimmed, max 50,
     no E.164 normalization in v1), locale? (must be a supported catalog
     locale, de|en; defaults to workspace default). status is not an input
     (always active). Creating an owner/manager without email succeeds with
     warning code no_email_for_invitable_role.
  4. person.update is PARTIAL (patch semantics): input person_id (required)
     plus any of display_name, role_class, email, phone, locale. Absent =
     unchanged; explicit null clears email/phone only (display_name,
     role_class, locale are non-nullable). Empty patch rejected. Not
     updatable via this action: status, auth_user_id, pin_hash. Target must
     not be pseudonymized. Rationale: minimal audit diffs, offline-safe
     (no read-modify-write clobber), legible agent proposals.
  5. Role authority: only an owner actor may create a person with
     role_class=owner, change role_class to/from owner, or update /
     deactivate / pseudonymize a person whose role_class=owner. Otherwise
     actors O, M per catalog; pseudonymize remains O only.
  6. Last-owner guard: reject deactivate, pseudonymize, and role_class
     demotion when the target is the workspace's sole active owner
     (error: last_owner_protected).
  7. person.deactivate: input person_id, reason (1–2000). Transition
     active → inactive only. reason in audit extras. No person.reactivate
     exists in the catalog; none is added here (separate DEC if needed).
  8. person.pseudonymize recipe (single kernel transaction, terminal state,
     allowed from active or inactive):
     - display_name → 'Person ' + last 6 hex of person id (deterministic,
       non-identifying, keeps lists/exports readable)
     - email, phone, pin_hash, auth_user_id → NULL
     - locale → workspace default
     - status → 'pseudonymized'
     - all non-revoked auth_devices of the person → revoked, audited under
       the same invocation (kernel-internal cascade, not the device.revoke
       public action)
     Input: person_id, legal_basis { kind enum(data_subject_request,
     retention_policy, other), note (1–2000, required) }, stored verbatim
     in audit extras together with cleared_fields.
  9. Audit-redaction exception: the pseudonymize audit event MUST NOT
     contain pre-erasure PII values. Its before-diff records field names
     only (cleared_fields); values are never written. Prior audit_events
     remain untouched (insert-only wins); their eventual fate is governed
     by §16 retention windows, justified by the stored legal basis.
  10. Idempotency: client UUID for all four actions (per catalog); replay
      returns the byte-identical envelope (F24/F30).
  Approved by: Vitali Voinski (operator), 2026-07-08; transcribed by Codex.
- Architecture impact: §5 person rows amended to the exact inputs above;
  §16 erasure paragraph gains the recipe and the audit-redaction exception
  (rule 9); Bootstrap ambiguities note updated (person portion resolved).
  Doc changes via doc-PR by the operator.

### DEC-009 — 2026-07-08 — SLICE-007 client/site scope, site.create initial status, and supervisor_person_ids authz contract
- Status: RESOLVED
- Raised by: SLICE-007 implementation stop (client + site actions). No code
  written — this entry precedes it per AGENTS.md CHANGE-REQUEST FORMAT.
- Question: five blocking sub-questions, each independently sufficient to stop
  the slice.

  **(1) Are `site.activate` / `site.archive` in Phase 0 at all?**
  §19 Phase 0 says only "Actions: that set". PROGRESS.md "Bootstrap
  ambiguities" reads that as the full catalog set "including person.pseudonymize
  and site.activate/archive (billing-meter actions before entitlements exist) —
  confirm." DEC-008 resolved the person half and states verbatim: "the
  site.activate/archive portion remains open for SLICE-007." AGENTS.md: a note
  marked "confirm" is an open question — do not build on it until a RESOLVED
  entry exists. None does.
  Options: (A) in Phase 0 — the meter is written before any entitlement gate
  enforces it (Phase 0 resolver is noop-unlimited, §19); a reviewer picks this
  if PROGRESS.md's SLICE-007 "Done when" is to be met as written. (B) defer
  activate/archive to Phase 5 alongside the `sites.active` gate (SLICE-040), so
  the meter action and its enforcement ship together; a reviewer picks this to
  avoid a billing-relevant write path existing unenforced for four phases —
  requires amending SLICE-007's "Done when", which is a CHANGE-REQUEST per
  AGENTS.md WORKFLOW. (C) ship activate/archive in Phase 0 but declare
  `gate: sites.active` on them now, resolved by the noop resolver until
  SLICE-040 populates plans.
  Smallest-safe default: none — hard blocked. Building them presumes (A);
  omitting them presumes (B). Both are visible in the action catalog surface.

  **(2) What `status` does `site.create` write?**
  §3 fixes sites states as exactly {active, archived} — there is no pre-active
  state. §5 makes `site.create` proposal_gated but `site.activate` human_only
  "(billing meter)". §9 [FIXED]: "Active site = the metered value unit —
  sites.status='active', with site.activate/site.archive as explicit audited
  human actions so the meter is legible to customers."
  Options: (A) create → 'active': a proposal_gated action increments the §9
  meter directly and human_only `site.activate` is unreachable for new sites,
  contradicting §9's legibility rationale. (B) create → 'archived': the meter
  stays legible and activate is the sole entry onto it, but a newly created
  site sits in a state §3 names 'archived' before it was ever active. (C) §3's
  state list is incomplete and sites need a third pre-active state — a schema
  change, which §19 [FIXED] forbids outside Phase 0 migrations and which
  AGENTS.md routes through CHANGE-REQUEST.
  Smallest-safe default: none — hard blocked. (A) and (B) differ in whether a
  proposal_gated action can move the billing meter.

  **(3) What validates `sites.settings.supervisor_person_ids` on write?**
  §3 calls it "the authz source for supervisor site scope, F12"; §8 (F12): "a
  supervisor's site set is exactly the sites whose settings.supervisor_person_ids
  include them ... that membership is the authz source deciding which day-packs
  they see and which windows they may close or raise exceptions on."
  Options: (A) accept any uuid array unvalidated — a manager (or an approved
  agent proposal) can grant day-pack visibility to any uuid, including a person
  row in another workspace, with only RLS on the day-pack read as backstop.
  (B) validate each id references an existing, active, in-workspace person.
  (C) additionally require `role_class='supervisor'` — rejects listing a
  manager, who per §8/F6 already inherits supervisor rights workspace-wide.
  Smallest-safe default: none — hard blocked. AGENTS.md: "if candidate
  interpretations differ in what any actor can see or do, it is not an
  implementation detail — stop instead," and a write that widens who can see
  what is SECURITY/AUTHZ scope regardless of read/write classification.

  **(4) What is the `fields` input contract for client.* and site.*?**
  §5 gives "fields" (client) and "client_id, fields" (site). Undefined: how
  `update` identifies its target; full-replacement vs patch semantics; the
  shape of `clients.contact jsonb` and `sites.address jsonb`; whether
  `settings` is writable wholesale on `site.create`. DEC-008 treated the
  identical class of question for persons as CHANGE-REQUEST material and
  resolved it by operator sign-off (flat fields 1:1 to §3 columns; patch
  semantics; explicit null clears). Action input schemas are exported as JSON
  Schema and are "the future public API and MCP tool surface" (§5), and jsonb
  shapes are stored data formats — both on AGENTS.md's STOP list.
  Smallest-safe default: mirror DEC-008 (flat 1:1 columns, patch update keyed
  by client_id/site_id, explicit null clears nullable columns) — valid only if
  the operator also fixes the two jsonb shapes, which DEC-008 did not cover.

  **(5) Does `client.archive` cascade to that client's sites?**
  §3: nothing hard-deletes, lifecycle via status; FKs ON DELETE RESTRICT.
  clients and sites each have {active, archived}. If archiving a client leaves
  its sites `status='active'`, those sites keep counting on the §9 active-site
  meter and keep appearing in supervisor day-packs.
  Options: (A) no cascade — archived client retains billable active sites.
  (B) cascade to sites in the same kernel transaction, auditing one event per
  site; but if (1) resolves that site.archive is human_only/meter-legible, a
  proposal_gated client.archive would then move the meter transitively.
  (C) reject client.archive while any of its sites is active.
  Smallest-safe default: none — hard blocked; (A) and (B) differ in billing
  outcome, and (B)'s legality depends on the answer to (1).

  Why this needs human sign-off: sub-questions (1), (2) and (5) affect PRODUCT
  behavior and the §9 [FIXED] billing meter — the concrete harm is a
  proposal_gated write path silently moving a customer-billable, "legible"
  meter, on an append-only audit trail that cannot be retroactively corrected.
  Sub-question (3) is SECURITY/AUTHZ: the wrong default grants day-pack and
  window-close visibility across the supervisor scope boundary. Sub-question
  (4) fixes stored data formats and the exported public API surface. All four
  categories are on AGENTS.md's STOP list.
- Resolution:
  1. (Q1, site.activate/archive lifecycle) Path B — add a non-billable
     'draft' state to site_status. site.create writes 'draft'. site.activate
     ships this slice as human_only and is the sole meter-moving event.
     site.archive stays deferred per DEC-008. Rationale: §9's [FIXED]
     meter-legibility guarantee is about the gate CLASS of the meter-moving
     action, not merely a human in the loop. A proposal_gated site.create
     that writes 'active' would move the customer-billable meter through an
     action on AgentProposal's autonomous-safe promotion path — violating §9
     silently the day it promotes, with no schema signal. Reversibility
     seals it: an unused enum value is free if wrong; a false billable event
     on an append-only, billing-grade (Leistungsnachweis) trail is a
     permanent defect.
  2. (Q2, site.create status) Writes 'draft' (follows from Q1).
  3. (Q3, supervisor_person_ids validation) Yes. Entries must be existing,
     active, in-workspace persons with role_class='supervisor'. Reject any
     id failing this. It is an authz grant, not a persistence field; an
     unvalidated write is a cross-workspace visibility hole on an
     append-only trail.
  4. (Q4, client/site input shape) Confirmed: DEC-008 shape — flat 1:1
     columns, patch update semantics, null clears. clients.contact / sites.
     address jsonb shapes to be fixed by the implementing agent accordingly
     (implementation detail, logged as a one-liner per AGENTS.md AMBIGUITY,
     not re-opened here).
  5. (Q5, client.archive cascade) Reject-while-sites-active. client.archive
     refuses if the client has any non-archived site; forces explicit
     teardown rather than silent cascade on billing-relevant records.
  Carried-forward, NOT resolved now: Path B's 'draft' state introduces
  further lifecycle questions left unspecified — stale-draft handling,
  whether drafts count toward active-site entitlement metering (§9), and
  draft-visibility rules. This is a named open item for a future slice; no
  answer is assumed here and none should be built against it.
  Approved by: Vitali Voinski (operator), 2026-07-08; transcribed verbatim
  by the implementing agent.
- Architecture impact: amends the §3 sites states (adds 'draft' — schema
  migration rides with the SLICE-007 implementation PR, not this doc-PR);
  amends §19 Phase 0 action set (site.create/update/activate confirmed in
  Phase 0; site.archive confirmed deferred); PROGRESS.md Bootstrap
  ambiguities note updated (site portion resolved, draft-lifecycle item
  carried forward). Doc changes via doc-PR by the operator.

### DEC-010 — 2026-07-08 — SLICE-008 manager auth: auth_user_id population, active-workspace session contract, login eligibility, membership listing
- Status: RESOLVED
- Raised by: SLICE-008 implementation stop (manager auth — magic link, session,
  login + authenticated shell). No code written — this entry precedes it per
  AGENTS.md CHANGE-REQUEST FORMAT.
- Question: four blocking sub-questions, each independently sufficient to stop
  the slice.

  **(1) What populates `persons.auth_user_id`?**
  §3 persons: "auth_user_id uuid? (Supabase Auth user; unique per workspace;
  populated at invite acceptance — F11)". No invite action exists in the §5
  catalog, and §16 / §19 Phase 0 define no invite flow. SLICE-008's done-when
  assumes the magic link "resolves to a persons row via auth_user_id" without
  defining how that column ever got its value.
  Options: (A) auto-link on first magic-link login by exact email match against
  `persons.email` — no catalog change; consequence: `person.update` of an email
  (manager-level today, on the AgentProposal promotion path later) becomes an
  access grant — whoever controls that inbox gains the person's roles at next
  login; also needs a rule for the same email appearing on persons rows in
  several workspaces (F11 uniqueness is per workspace, not global). (B) an
  explicit invite step (e.g. `person.invite` issuing the Supabase Auth invite;
  auth_user_id written at acceptance) — the literal reading of §3's "invite
  acceptance"; consequence: adds a catalog action and an acceptance route — a
  visible API-surface change only a DEC can authorize. (C) platform-actor
  manual linking — smallest surface; consequence: operator-in-the-loop for
  every manager onboarding; incompatible with Phase 5 self-serve workspace
  creation (SLICE-041 depends on SLICE-008).
  Smallest-safe default: none — hard blocked. The options differ in who can
  gain login access to a workspace.

  **(2) Where does the active workspace live, and what re-validates it?**
  §16: "with the active workspace explicit in the session". Undefined: the
  trust anchor and revocation latency.
  Options: (A) workspace_id as a Supabase JWT claim — stamped at mint;
  deactivation or role change survives until token refresh (stale-claim authz
  window); switching workspaces = re-mint. (B) the auth session carries
  identity only; the selected workspace_id (own httpOnly cookie) is re-validated
  on every request against an active persons row for (auth_user_id,
  workspace_id) before the kernel sets the `app.workspace_id` GUC —
  consequence: one indexed lookup per request; revocation is immediate; the
  client-held value is selection intent, never authority. (C) a server-side
  session table — durable and revocable, but a table §3 does not define
  (schema change; Phase 0 migrations could still carry it, but only a DEC can
  authorize it).
  Smallest-safe default (if allowed to proceed): (B) — least authority held
  client-side, immediate revocation, reversible toward (A) or (C). Remains
  STOP because the options differ in what a deactivated actor can still see
  during the stale window (TENANCY).

  **(3) Who may establish a dashboard session, and what do edge resolutions do?**
  §16 names managers for the magic link; §8 fixes surfaces (supervisor → PWA
  capture, worker → none in v1) and F6 inheritance covers action grants, not
  surfaces. Unruled: (a) an identity resolving to zero persons rows — typed
  rejection at session establishment vs. an empty no-workspace shell; (b)
  status='inactive' persons — DEC-008 defined deactivate without stating its
  login effect (pseudonymized is settled: the DEC-008 recipe NULLs
  auth_user_id); (c) supervisors/workers who do have an email and magic-link
  in — whether those memberships are pickable and whether they reach the
  authenticated shell at all.
  Smallest-safe default: only active persons with role_class in {owner,
  manager} establish dashboard sessions; zero-membership identities and every
  other resolution receive one typed, catalog-translated rejection. Offered as
  a default but still STOP: each case decides who can see what surface.

  **(4) May session establishment list the identity's workspace memberships before SLICE-010 mounts the reads layer?**
  F11 permits multiple memberships, so login must select among them; core/reads
  mounts only in SLICE-010 (which depends on 008). A membership list
  (workspace id + name per active persons row of the identity) is a new read
  exposing cross-workspace data to an identity — AGENTS.md classifies any read
  that widens who-can-see-what as SECURITY/AUTHZ scope.
  Options: (A) the session-establishment route returns the identity's
  memberships (workspace id + display name only), justified by §16's F11
  sentence — consequence: a read endpoint exists before the reads layer, owned
  by auth; (B) Phase 0 auto-selects when exactly one active membership exists
  and returns a typed error for multi-membership identities until SLICE-010 —
  grants least, but arguably under-delivers SLICE-008's done-when sentence
  "one auth identity can hold roles in multiple workspaces (F11)".
  Smallest-safe default: none — (A) and (B) differ in both exposure and
  delivered scope.

  Not asked (settled): the authenticated shell renders catalog strings only
  with no data reads (SLICE-008 done-when); magic-link email transport is
  Supabase Auth SMTP → Resend, infra config (F23, Appendix table); login
  itself writes no audit_event — it is not a §5 catalog action and audit
  events exist only inside kernel transactions (§6), so Supabase Auth's own
  logs cover it.

  Why this needs human sign-off: (1) and (3) are SECURITY/AUTHZ — the concrete
  harm is an email-match or eligibility default silently granting dashboard
  access to the wrong identity. (2) is TENANCY — the active-workspace anchor
  is what every per-transaction `app.workspace_id` GUC derives from. (4)
  creates a who-can-see-what read. All four categories are on AGENTS.md's
  STOP list, and every one is visible outside the code (session cookies,
  rejection responses, API surface), so none qualifies as an
  implementation detail.
- Resolution:
  1. (Q1, auth_user_id population) Option B — explicit invite. §3's "populated
     at invite acceptance" is binding text: Option A (auto-link by email match)
     would contradict it and turn `person.update` of an email into an access
     grant; Option C breaks Phase 5 self-serve workspace creation (SLICE-041).
     Add a §5 catalog action `person.invite` (actors O, M; human_only — it
     grants dashboard access and sends mail; input `person_id`; idempotency
     client uuid). Preconditions: target status='active', role_class in
     {owner, manager}, email present, auth_user_id IS NULL; re-invite permitted
     while still unlinked, typed rejection once linked. Transport is the
     Supabase Auth invite email over SMTP → Resend (F23), not
     outbound_messages. Acceptance carries the (workspace, person) binding and
     is completed by a kernel-internal op `person.link_auth` (Appendix B
     pattern) that writes `auth_user_id` only after verifying the accepting
     auth identity's email still equals `persons.email`, emitting an audit
     event. F11 holds as one invite per workspace: the same auth user links to
     one persons row in each workspace independently.
  2. (Q2, active workspace) Option B — per-request re-validation. The Supabase
     session carries identity only. The selected `workspace_id` lives in its
     own httpOnly cookie as selection intent, never authority: every request
     re-resolves (auth_user_id, workspace_id) to an active, eligible persons
     row before the kernel sets the per-transaction `app.workspace_id` GUC;
     failure clears the cookie and returns a typed rejection. Workspace
     switching is an explicit endpoint running the identical validation.
     Cost: one indexed lookup per request (the partial unique
     persons(workspace_id, auth_user_id) index from SLICE-002 serves it).
     Benefit: deactivation and pseudonymization revoke access immediately —
     no stale-claim window, which Option A's JWT claim cannot offer. Remains
     reversible toward A or C if the lookup ever measures.
  3. (Q3, session eligibility) Dashboard sessions are established only for
     persons with status='active' and role_class in {owner, manager}. An
     identity resolving to zero qualifying memberships receives one typed,
     catalog-translated rejection at session establishment — the Supabase
     identity may exist, no workspace session is granted. Inactive persons are
     excluded: deactivation means access removal. Supervisors and workers with
     an email do not qualify for the dashboard and their memberships never
     appear in the picker; their surface remains the PWA via device enrollment
     (§8 surfaces table, §16). Pseudonymized persons are already unreachable —
     DEC-008's recipe NULLs `auth_user_id`.
  4. (Q4, membership listing) Option A. The session-establishment route returns
     the identity's qualifying memberships only — workspace id + display name,
     filtered by rule 3, no other field — and the endpoint is owned by the auth
     route, not `core/reads` (which mounts in SLICE-010). §16's "active
     workspace explicit in the session" together with F11 requires a selection
     step to exist; Option B would lock multi-workspace identities out until
     SLICE-010 and under-deliver SLICE-008's "Done when" as written.
  `person.invite` and `person.link_auth` ship in Phase 0 / SLICE-008 — they are
  the mechanism §3's persons row already presumes, not new product scope.
  Proposal authored by the implementing agent (Claude Fable 5); approved
  without edit by Vitali Voinski (operator), 2026-07-08; transcribed by the
  implementing agent.
- Architecture impact: amends the §16 auth paragraph (invite-acceptance
  linking, the per-request-revalidated session contract, dashboard eligibility);
  amends the §5 action catalog (adds the `person.invite` row); amends
  Appendix B (adds the `person.link_auth` kernel-internal op); §19 Phase 0
  action set covers both. No schema change (`persons.auth_user_id` and its
  partial unique index already exist). Doc changes via doc-PR by the operator.

---

### DEC-011 — 2026-07-08 — RLS-safe dashboard membership listing before workspace selection
- Status: RESOLVED
- Raised by: SLICE-008 PR #13 rejection fix (F1/F3). No implementation code
  written for the answer-dependent fix.
- Question:
  CHANGE-REQUEST
  - Blocking question: How may the auth/session establishment route list all
    qualifying dashboard memberships for a Supabase Auth identity before a
    workspace is selected, while keeping request-path database traffic on the
    `app_kernel` role subject to RLS?
  - Architecture section(s) involved: §7 access-path ruling / RLS GUC
    contract; §16 auth paragraph as amended by DEC-010; DEC-010 Resolution 2
    and Resolution 4.
  - Options considered: (A) Add an RLS-safe database lookup path for
    auth-session membership discovery, for example a narrowly scoped
    policy/function that returns only `{workspace_id, workspace_display_name}`
    for rows whose `persons.auth_user_id` equals the verified Supabase
    identity. A reviewer picks this to keep the membership source relational
    and immediately revocable while making the pre-selection lookup possible
    under RLS. (B) Store non-authoritative candidate workspace ids in Supabase
    Auth app metadata at invite/link time, then validate each candidate under
    `app_kernel` with `app.workspace_id` set before returning only qualifying
    memberships. A reviewer picks this to avoid a Postgres schema/policy
    change, accepting a new external stored-data format and stale candidates
    that must never become authority. (C) Change session establishment to
    require a client-supplied `workspace_id` and remove pre-selection
    membership listing until another read path exists. A reviewer picks this
    to keep the current RLS model unchanged, accepting that F11
    multi-workspace identities cannot discover or choose among memberships
    from login alone. (D) Keep the current owner-role auth pool for membership
    listing. A reviewer would only pick this for implementation speed, but it
    contradicts §7 and the PR rejection because RLS is enabled but not forced,
    so the table owner bypasses the backstop.
  - Smallest-safe default (if allowed to proceed): none — hard blocked.
    Option D is disallowed; C changes product behavior; A is a schema/RLS
    design; B adds a security-relevant external stored-data format.
  - Why this needs human sign-off: TENANCY and SECURITY/AUTHZ. The concrete
    harm of the wrong default is either cross-tenant membership disclosure via
    an owner-role bypass, login lockout for legitimate F11 multi-workspace
    identities, or treating stale/forged identity metadata as an authorization
    source.
- Resolution: Option 1 — RLS-safe SECURITY DEFINER lookup mirroring SLICE-003's
  app_platform_invocation_lookup: a STABLE SECURITY DEFINER fn (empty search_path,
  schema-qualified, EXECUTE to app_kernel only) returning ONLY {workspace_id,
  workspace_display_name} for a given auth_user_id, filtered to status='active',
  role_class in {owner,manager}, active workspaces. core/db/auth.ts moves onto app_kernel
  under RLS; per-request revalidation sets app.workspace_id and uses the normal tenant
  policy for the selected workspace; the pre-selection listing uses this fn. Per-workspace
  RLS policies untouched; no external metadata as authority. Resolves F1 and F3; authorizes
  one migration (the fn only). Proposed by the judge (Claude Opus 4.8), approved without edit
  by Vitali Voinski, 2026-07-08; transcribed by the implementing agent.
- Architecture impact: amends §7/§16 and DEC-010's membership-listing
  implementation contract with an RLS-safe pre-selection lookup function.

---

### DEC-012 — 2026-07-09 — Invite-linking binds to the invited email
- Status: RESOLVED
- Raised by: SLICE-008 / PR #13 residual R1
- Question: Does DEC-010 R1's "the accepting identity's email still equals persons.email" bind `person.link_auth` to the email at the time `person.invite` was issued, or only to the current `persons.email` at acceptance time?
- Resolution: Invite-linking binds to the invited email. DEC-010 R1's 'the accepting identity's email still equals persons.email' means the accepting Supabase identity's email must equal the email the person.invite was issued to — not merely the current persons.email at acceptance time. Rationale: otherwise a person.update of the email during the invited-but-unlinked window turns person.update into an access grant (the exact harm §16/DEC-010 R1 rejects).
- Approved without edit by: Vitali Voinski (operator), 2026-07-09; proposed by the judge (Claude Opus 4.8); transcribed by the implementing agent.
- Architecture impact: none — resolves DEC-010's invite-acceptance link predicate.

---

### DEC-013 — 2026-07-12 — Supervisor authentication unified onto Supabase Auth; device-token/PIN path removed from v1; login-provider set fixed
- Status: RESOLVED
- Raised by: SLICE-009 pre-implementation architecture review plus operator
  product rulings on browser-first surface strategy, unified accounts, and
  social-login requirements. No answer-dependent application code written.
- Question:
  CHANGE-REQUEST
  - Blocking question: Does SLICE-009 build the §16 device-enrollment system
    (`device.enroll`, `device.claim`, `device.revoke`, device token, and PIN),
    or extend the SLICE-008 Supabase identity to supervisors?
  - Architecture section(s) involved: §3 persons/auth_devices and
    execution_records; §4 ExecutionRecord; §5 action catalog and
    kernel-internal operations; §7 access path; §8 roles/surfaces; §9
    entitlements; §10 capture surface; §11 offline/sync; §16 auth and privacy;
    §18 deferred paths; §19 Phase 0/1; §20.8/10; §21.2/10/12; Appendices A/B;
    DEC-008 and DEC-010 through DEC-012; PROGRESS.md
    SLICE-009/010/011/015/016/021/043.
  - Options considered:
    - (A) Extend Supabase identity — recommended. Owners, managers, and
      supervisors share DEC-010/DEC-012's invite/link/session contract.
      Supervisors enter the capture surface while dashboard routes reject
      them. Consequence: one account system, immediate per-request
      deactivation/role enforcement, and email magic link plus Google OAuth in
      v1; one DEC-authorized migration widens DEC-011's membership function.
    - (B) Keep device enrollment. Supervisors claim manager-issued QR/8-digit
      codes, receive device tokens, and unlock with PINs. A reviewer would pick
      this to retain email-less onboarding and installed-PWA storage isolation.
      Consequence: v1 carries a parallel public authentication system,
      credential lifecycle, rate limits, audit operation, and support burden.
      Rejected because browser-first operation and provisioned supervisor email
      remove its justifications, and it is a dead end against the
      native-app/unified-account direction.
    - (C) Hybrid. Supervisors may use Supabase identity or device enrollment.
      A reviewer would pick this to retain an email-less fallback while adding
      social login. Consequence: both credential systems and their routing,
      revocation, testing, and support obligations remain. Rejected as the
      union of A and B's costs.
  - Smallest-safe default (if allowed to proceed): none — hard blocked.
  - Why this needs human sign-off: PRODUCT behavior, DOMAIN model, ACTION
    kernel, TENANCY, PRIVACY/PII, and SECURITY/AUTHZ. The wrong default could
    grant dashboard access to supervisors, retain access after deactivation,
    create an unsupported public credential path, or flush offline writes
    under a stale session.
- Resolution:
  1. `person.invite` widens its precondition from `role_class` in
     `{owner, manager}` to `{owner, manager, supervisor}`. All other DEC-010
     and DEC-012 semantics remain unchanged: acceptance binds to the email to
     which the latest invite was issued; email-match auto-linking remains
     rejected; re-invite remains permitted while unlinked; linked persons
     receive the existing typed rejection.
  2. Session eligibility widens to active persons with `role_class` in
     `{owner, manager, supervisor}`. DEC-010 Resolution 2 remains unchanged:
     the Supabase session carries identity only; the selected `workspace_id`
     cookie is selection intent, never authority; every request revalidates the
     membership; and workspace switching uses an explicit endpoint running
     identical validation. F11 remains unchanged: one auth identity may hold
     roles in multiple workspaces. DEC-010 Resolution 4 remains unchanged:
     session establishment returns qualifying memberships as workspace id and
     display name only.
  3. DEC-010 Resolution 3 changes only from supervisor session denial to
     surface routing. Supervisor sessions reach `(capture)` routes only;
     `(dashboard)` routes return a typed, catalog-translated rejection.
     Owner/manager capture access remains unchanged.
  4. DEC-011's membership function widens its role filter to
     `{owner, manager, supervisor}` through one migration authorized by this
     decision, mirroring DEC-011's precedent. Its active-person,
     active-workspace, RLS, SECURITY DEFINER, and return-field contracts remain
     unchanged.
  5. `device.enroll`, `device.claim`, and `device.revoke` are removed from the
     v1 public catalog and registry. Appendix B's `device.touch` is removed.
     `auth_devices`, `persons.pin_hash`, and `execution_records.device_id`
     remain reserved, unused, and unmigrated; `execution_records.device_id` is
     always NULL in v1 and the `record.capture` audit extra records it as
     reserved/NULL. No substitute client identifier is introduced. Reopening
     device credentials or adding a client-instance identifier requires a new
     decision.
  6. `proof.complete_upload` replaces actor `device` with S, M; Y remains.
     The capturing person's Supabase session invokes completion after blob
     upload, while the system path remains available.
  7. Email magic link and Google OAuth ship in v1. Google acceptance uses only
     Supabase's provider-verified email, requires `email_verified=true`, and
     compares the case-normalized verified email to the case-normalized invited
     email. DEC-012's invited-email predicate otherwise remains unchanged.
  8. Apple enters only when iPhone-holding supervisors are present at the
     pilot and the developer account exists. Microsoft/Entra enters only when
     an Enterprise-tier customer names it under §9's SSO reservation. Passkeys
     are post-v1 convenience credentials on existing accounts only. Passwords,
     SMS OTP, and long-tail social providers are excluded and require a new
     decision to reopen. §16's SMS-OTP rejection stands. A provider enters only
     when a named user group demonstrably holds that account type and the phase
     touches that group's login surface.
  9. Workers remain outside the account system in v1. Worker read-own remains
     the §18 deferred item and reuses the same invite mechanism.
  10. Supervisor seats remain free under §9. Future pricing changes belong in
      `plans.limits`, not authentication.
  11. On reconnect, the client refreshes the Supabase session and completes
      per-request membership validation before flushing the outbox. Cached
      day-pack rendering never requires a live token. This lands in
      SLICE-015/021 contract text.
  12. DEC-008's pseudonymization recipe continues to revoke matching
      `auth_devices`. Because the table is reserved and empty in v1, that
      merged code path is a harmless no-op; no code or DEC-008 amendment is
      required.
  13. The `(capture)` and `public/` repo-map names and comments remain
      unchanged. The manifest and service worker still ship; installation is
      optional, while the service worker continues to support offline capture.
- Approved by: Vitali Voinski (operator), 2026-07-12; proposal authored by the drafting agent, transcribed by the implementing agent.
- Architecture impact: amends §3, §4, §5, §7 through §11, §16, §18, §19,
  §20.8/10, §21.10, and Appendices A/B as shown below. §21.2 applies to the
  reduced catalog without textual amendment; §21.12 and the repo map remain
  unchanged. PROGRESS.md is amended as shown below.

---

### DEC-014 — 2026-07-12 — SLICE-009 Google invite handoff and capture/dashboard route contract
- Status: RESOLVED
- Raised by: SLICE-009 implementation stop after DEC-013 doc-PR #20 merged.
  No answer-dependent implementation code written.
- Question:
  CHANGE-REQUEST
  - Blocking question: Two contracts required by DEC-013 remain unspecified.

    **(1) How does an invited but unlinked supervisor carry the explicit
    `(workspace_id, person_id)` invite binding through Google OAuth?**
    DEC-010 rejects email-match auto-linking and requires explicit invite
    acceptance; DEC-012 binds acceptance to the invited email; DEC-013 requires
    Google acceptance using a provider-verified, case-normalized matching
    email. The current generic Google login has no person/workspace binding,
    while the current invite redirect carries that binding only into
    `/auth/accept`.

    Options considered: (A) Require the existing email invite acceptance to
    link `persons.auth_user_id` first; Google is a subsequent login method for
    the already-linked Supabase user. A reviewer picks this for the smallest
    implementation and no new OAuth state contract, accepting that Google is
    not itself an invite-acceptance path. (B) Add a direct Google invite
    acceptance flow: the bound invite acceptance surface starts Google OAuth,
    round-trips the workspace/person binding in server-validated, CSRF-bound
    state, then invokes `person.link_auth` only after the returned Supabase
    session proves OAuth plus a Google identity whose provider email is
    verified and matches the invited email case-insensitively. A reviewer picks
    this to make "Google acceptance" literal, accepting a new visible flow,
    state/cookie contract, and tests. (C) Let generic Google login find an
    unlinked pending invite by verified email. A reviewer picks this for the
    simplest user journey, but it reintroduces email-match auto-linking and
    discards DEC-010/DEC-012's explicit workspace/person binding.

    Smallest-safe default: none — hard blocked. A does not deliver direct
    Google invite acceptance; B adds a security-relevant state and route
    contract; C contradicts the resolved invite-binding decisions.

    **(2) Which concrete routes are the `(capture)` and `(dashboard)` surfaces,
    and what response constitutes the required typed, catalog-translated
    dashboard rejection?**
    The repo currently has only `app/page.tsx` at `/`; the §19 route-group names
    are not URL segments and no capture shell exists.

    Options considered: (A) Keep `/` as dashboard, add `/capture` as the
    capture shell, redirect supervisors there after session establishment, and
    make dashboard page requests render a catalog-translated typed rejection.
    A reviewer picks this to preserve the existing root URL, accepting a new
    public `/capture` path and a page-level rejection representation. (B) Make
    `/` a role router and add explicit `/dashboard` and `/capture` surfaces.
    A reviewer picks this for the clearest permanent boundary, accepting two
    new visible paths and a change to the current root behavior. (C) Keep `/`
    as one role-sensitive shell that renders dashboard or capture content from
    the per-request membership, deferring explicit route paths until those
    surfaces grow. A reviewer picks this for the smallest routing change, but
    SLICE-009 cannot demonstrate a dashboard-route typed rejection because no
    distinct dashboard route exists. For A or B, the rejection could be either
    an HTTP JSON envelope or a rendered catalog-translated page carrying the
    typed code; those are externally different contracts.

    Smallest-safe default: none — hard blocked. The options define different
    visible URLs and different observable error responses.

  - Architecture section(s) involved: §8 surfaces table; §16 auth paragraph;
    §19 repo map and Phase 0 done-means; §21.10; DEC-010 Resolutions 1–4;
    DEC-012; DEC-013 Resolution items 2, 3, 4, 7, and 13; PROGRESS.md
    SLICE-009 Done-when.
  - Options considered: Enumerated under each blocking sub-question above.
  - Smallest-safe default (if allowed to proceed): none — hard blocked.
  - Why this needs human sign-off: SECURITY/AUTHZ and visible API/surface
    behavior. The wrong Google handoff can link an identity without the
    explicit invited person/workspace grant or make the approved Google path
    impossible. The wrong route contract can expose dashboard content to a
    supervisor, silently change existing URLs, or establish an unapproved
    externally visible error format.
- Resolution:
  1. (Q1) Option B — direct Google invite acceptance. The invite
     acceptance surface offers both paths: the existing magic-link/email
     acceptance (unchanged), and a Google OAuth acceptance. The
     (workspace_id, person_id) invite binding round-trips through the
     OAuth flow in server-validated, CSRF-bound state (httpOnly cookie
     plus state-parameter comparison; never in client-editable storage
     or user_metadata). person.link_auth is invoked only after the
     returned Supabase session contains a Google identity whose email is
     read from identities[].identity_data, has email_verified=true, and
     equals the invited email case-normalized (DEC-012/DEC-013 item 7
     predicate). user_metadata is never an authorization or verification
     input. Option C remains rejected as email-match auto-linking.
  2. (Q2) Option B — "/" becomes a role router that re-resolves the
     active membership per request and redirects: owner/manager →
     /dashboard, supervisor → /capture. /dashboard and /capture are the
     concrete surfaces for §19's (dashboard) and (capture) route groups.
     A supervisor session requesting any /dashboard route receives
     HTTP 403 with a rendered, catalog-translated page carrying the
     typed rejection code; /api/actions and /api/reads keep the existing
     JSON envelope with the same catalog key. Owner/manager access to
     /capture remains per F6 inheritance.
  3. Architecture impact: concretizes §16/§19 and DEC-013 items 3, 7,
     and 13 at implementation level; no ARCHITECTURE.md text amendment
     required — route paths and the OAuth state mechanics are
     implementation contracts recorded by this entry. SLICE-009
     Done-when is satisfiable as written; no PROGRESS.md change.
- Approved by: Vitali Voinski (operator), 2026-07-12; proposal reviewed by the judge (Claude), transcribed by the implementing agent.
- Architecture impact: concretizes §16/§19 and DEC-013 items 3, 7, and
  13 at implementation level; no ARCHITECTURE.md text amendment required.

### DEC-015 — 2026-07-12 — Plan adjustments — web push committed, draft-site lifecycle resolved, audit-derived analytics ruling, product efficiency targets
- Status: RESOLVED
- Raised by: operator planning review after SLICE-009 (PR #21) merge.
- Question:
  CHANGE-REQUEST
  - Blocking question: Should the v1 plan adopt all four independent planning
    rulings below: commit web push in Phase 3; close DEC-009's carried-forward
    draft-site lifecycle item; constrain future product and operational
    analytics to `audit_events` plus relational current state; and record
    operator-judged product efficiency targets outside CI and slice Done-when
    gates?
  - Architecture section(s) involved: §3 sites lifecycle; §6 audit/event
    strategy; §8 role and surface visibility; §9 active-site metering; §12
    digest behavior; §13 daily digest and promotion statistics; §14 channel
    architecture; §18 deferred upgrade paths; §19 Phase 3 and Phase 4;
    Appendix A; DEC-008; DEC-009; PROGRESS.md SLICE-033, SLICE-038,
    Bootstrap ambiguities, and the product-efficiency-targets block.
  - Options considered:

    **(1) Web push committed**

    - (A) Commit web push as a Phase 3 deliverable. The web-push channel
      adapter behind `outbound_messages` must deliver an escalation
      notification to a supervisor's browser, verified on desktop Chrome and
      Android. iOS Safari push, which requires the PWA to be added to the home
      screen, is verified and the constraint documented, but that verification
      does not gate the slice. A reviewer picks this because, after DEC-013
      removed device authentication and native applications remained deferred,
      the browser is the supervisor's terminal; email as the only immediate
      escalation channel is insufficient for frontline urgency.
    - (B) Retain the optional Phase 3 spike. A reviewer picks this to permit
      deferral if browser-push delivery or operations prove too costly;
      consequence: Phase 3 may close with email as the only immediate external
      escalation channel.
    - (C) Defer web push entirely until measured pilot failure of email. A
      reviewer picks this to minimize Phase 3 scope; consequence: no v1 browser
      escalation channel is committed despite DEC-013's browser-first strategy.

    **(2) Draft-site lifecycle — DEC-009 carried-forward item**

    - Metering: (A) draft sites never count toward §9's active-site meter;
      `draft` is non-billable by definition. (B) Draft sites count toward the
      active-site meter, causing `site.create` to move the billing outcome even
      though DEC-009 made `site.activate` the sole meter-moving event. (C)
      Drafts count against a separate plan limit, introducing a new entitlement
      dimension.
    - Visibility: (A) draft sites are visible only on owner/manager surfaces;
      they never appear in supervisor day-packs or client-facing surfaces, and
      `supervisor_person_ids` on a draft site confers no visibility or
      authorization until activation. (B) Draft sites appear to assigned
      supervisors but not clients, granting pre-activation visibility. (C)
      Draft sites follow active-site visibility everywhere, exposing incomplete
      setup data.
    - Stale handling: (A) no auto-expiry or destructive cron exists; the Phase
      4 daily digest gains a stale-drafts line for drafts older than the
      workspace-tunable `workspaces.settings.stale_draft_site_days`, default 30
      days. (B) Automatically archive stale drafts, requiring an undefined
      lifecycle action and authorization contract. (C) Automatically delete
      stale drafts, violating §3's no-hard-delete ruling. (D) Retain stale
      drafts silently with no operational signal.
    - Future archive transition: (A) keep `site.archive` deferred per DEC-008
      and DEC-009; when it ships it must accept `draft` as a from-state. (B)
      Allow archive only from `active`, leaving drafts unable to exit without
      activation. (C) Pull `site.archive` forward now, changing its expressly
      deferred phase and implementation scope.

    **(3) Audit-derived analytics ruling**

    - (A) Product and operational metrics derive exclusively from
      `audit_events` and relational current state through `core/reads`; no
      separate analytics store, event pipeline, or third-party product-
      telemetry system exists in v1. A future metrics read for exception MTTR,
      capture latency, and automation index is one read over `audit_events`, a
      candidate for Phase 6.
    - (B) Add a separate first-party analytics store or event pipeline, gaining
      analytics-specific aggregation at the cost of another data path,
      consistency model, privacy surface, and operational system.
    - (C) Add third-party product telemetry, gaining packaged funnels while
      exporting operational and user behavior into new tenancy, privacy, and
      consent obligations.
    - (D) Make no ruling until metrics are implemented, leaving later slices
      free to introduce incompatible telemetry paths.

    **(4) Product efficiency targets**

    - (A) Add a PROGRESS.md block explicitly labeled operator-judged, not §20
      CI gates: TTV from invite sent to first verified capture is <1 hour
      assisted and <1 day unassisted; the daily loop from Heute board to
      capture-done is ≤3 taps; automation index is the share of agent proposals
      approved without edit from Phase 4/5 promotion statistics. These numbers
      never gate CI or a slice's Done-when.
    - (B) Make the targets §20 CI or slice Done-when gates, converting assisted
      elapsed time and operator-observed outcomes into brittle/non-reproducible
      CI conditions.
    - (C) Keep the targets outside repository governance, leaving no durable,
      reviewable record of product-efficiency outcomes.
    - (D) Omit numerical targets while measurement is immature, leaving no
      shared success threshold.

  - Smallest-safe default (if allowed to proceed): none — hard blocked for any
    answer-dependent work. Until operator approval, retain the current optional
    web-push text; do not assume draft metering, visibility, stale handling, or
    archive transitions; build no metrics or telemetry path; and do not use the
    proposed efficiency targets as gates.
  - Why this needs human sign-off: items (1), (2), and (4) change PRODUCT
    behavior and phase/slice commitments. Item (2) also changes the §9 billing
    meter and SECURITY/AUTHZ visibility: the wrong default could bill a
    customer for incomplete setup state or expose incomplete sites before
    activation. Item (3) constrains the AUDIT model, TENANCY, and PRIVACY/PII
    surface: the wrong choice could create a second event truth or export
    tenant/user behavior to an unapproved telemetry system. These categories
    are on AGENTS.md's mandatory-stop list.
- Resolution:
  1. Web push is a committed Phase 3 deliverable. The web-push channel adapter
     behind `outbound_messages` delivers an escalation notification to a
     supervisor's browser, verified on desktop Chrome and Android. iOS Safari
     push is also verified with its PWA-home-screen requirement documented, but
     that verification does not gate the slice. With device auth removed by
     DEC-013 and native deferred, the browser is the supervisor's terminal;
     email alone is insufficient for frontline escalation urgency.
  2. DEC-009's carried-forward draft-site lifecycle item is resolved. Sites in
     `draft` never count toward §9's active-site meter and are non-billable by
     definition. Draft sites are visible only to owner/manager surfaces; they
     never appear in supervisor day-packs or client-facing surfaces, and
     `supervisor_person_ids` on a draft site confers no visibility or
     authorization until activation. No auto-expiry or destructive cron exists
     for stale drafts. The Phase 4 daily digest includes drafts older than
     `workspaces.settings.stale_draft_site_days`, whose workspace-tunable
     default is 30 days. `site.archive` remains deferred per DEC-008/DEC-009;
     when it ships it must accept `draft` as a from-state. This doc-PR also
     applies DEC-009's previously approved but unapplied §3 impact by changing
     the site states to `draft`, `active`, `archived`.
  3. Product and operational metrics derive exclusively from `audit_events`
     and relational current state via `core/reads`; no separate analytics
     store, event pipeline, or third-party product-telemetry system exists in
     v1. A metrics read for exception MTTR, capture latency, and automation
     index is one new read over `audit_events`, candidate Phase 6. Nothing is
     built by this ruling.
  4. PROGRESS.md records operator-judged product efficiency targets: invite
     sent to first verified capture <1 hour assisted and <1 day unassisted;
     Heute board to capture-done ≤3 taps; and automation index as the share of
     agent proposals approved without edit from Phase 4/5 promotion stats.
     These are operator-judged product numbers and never gate CI or a slice's
     Done-when.
- Approved by: Vitali Voinski (operator), 2026-07-12; proposal authored by the
  drafting agent, transcribed by the implementing agent.
- Architecture impact: amends §3, §6, §8, §9, §13, §14, §18, §19 Phase 3,
  and Appendix A; closes DEC-009's carried-forward draft-site lifecycle item;
  amends PROGRESS.md with the product-efficiency-targets block, SLICE-033,
  SLICE-038, and Bootstrap ambiguities.

### DEC-016 — 2026-07-12 — Phase 1 omnibus: capture/commitment/window/day-pack/outbox contracts (SLICE-012 → SLICE-021)
- Status: RESOLVED
- Raised by: Phase 1 pre-implementation ambiguity sweep (Fable,
  architect/judge), commissioned by the operator to replace reactive
  per-slice stops. No Phase 1 code written.
- Question: Fourteen STOP-tier contracts across SLICE-012–021 are
  underspecified in §3/§4/§5/§8/§10/§11 such that two reasonable implementers
  would build observably different systems — action input schemas (exported
  public API per §5), stored jsonb formats, state-machine edge transitions,
  cached-read surfaces, and offline flush behavior. Full options and
  consequences per item are in
  `docs/reviews/phase1-ambiguity-sweep-2026-07-12.md` (findings F-01…F-31);
  this entry records the question set and the approved resolutions.
- Options considered: per finding, 2–3 options each with the consequence that
  would make a reviewer pick it — see
  `docs/reviews/phase1-ambiguity-sweep-2026-07-12.md` §2 (incorporated by
  reference; the option lettering below matches it).
- Resolution:
  1. **F-01 → A.** spec jsonb carries `{window_start_time,
     window_end_time}` (local wall-clock, workspace tz) plus per-type extras
     (service_scope: checklist items); RRULE governs dates only; one window
     per commitment per local date stands per the [FIXED] §5 nat key.
  2. **F-02 → A.** Canonical shapes fixed for verification (proof demands),
     requirements (frozen copy of verification + checklist, derived solely
     from the commitment at generation), and fulfillment (`{rule,
     target_qty, unit, aggregate, satisfied, counted_record_ids,
     computed_at}`).
  3. **F-03 → A.** Coverage headcount = max(max coverage_confirm qty,
     distinct presence persons) over verified records — concurrency-safe,
     never double-counts.
  4. **F-04 → A.** service_scope completion = checklist-type proof
     (`proofs.checklist jsonb`, per-item done flags against frozen keys) on a
     service_confirmation record; service_scope shortfall raises exception
     type `output_shortfall`.
  5. **F-06 → A.** commitment.draft = flat 1:1 fields (DEC-008/009
     precedent) with the per-type required/forbidden matrix as specified;
     valid_from and valid_to remain required (schema unchanged); open-ended
     commitments deferred to a future widening DEC on pilot evidence.
  6. **F-07 → A.** commitment.update_spec = patch over {title, spec,
     schedule_rrule, target_qty, unit, verification, valid_from (draft only),
     valid_to}; type and site_id immutable; one contract for draft and active;
     A3 governs active effect.
  7. **F-10 → A.** window.generate gates on active commitments;
     already-generated scheduled windows of paused/completed commitments
     remain and run their course; no cancelled state in Phase 1; revisit on
     Phase 2 detector-noise evidence.
  8. **F-14 → A.** Day-pack schema fixed as specified: active sites in the
     caller's F12 scope (managers: all active sites, F6), assigned-persons-only
     roster (display_name + role_class), capture-namespace labels, empty-day
     shapes, name/starts_at ordering. DEC-015 item 2 already resolves
     draft-site visibility: drafts are owner/manager-only and never appear in
     supervisor day-packs or client-facing surfaces. This active-site-only
     day-pack schema is consistent with that resolved ruling; draft-site
     visibility is not carried forward.
  9. **F-16 → A.** record.capture per-kind required/forbidden matrix as
     specified; output unit must equal the window's frozen unit (typed
     rejection `unit_mismatch`).
  10. **F-17 → A.** Authorizes one post-Phase-0 migration (per §19's
      CHANGE-REQUEST route): additive nullable fact column
      `execution_records.note text` under the F4 trigger set; required
      (1–2000) for kind=note, forbidden otherwise.
  11. **F-18 → A.** record events accepted on any window not in `closed`;
      recompute may transition fulfilled↔shortfall and
      missed→fulfilled/shortfall as system-triggered transitions added to the
      §4 window machine before its Phase 1 freeze; `closed` rejects capture
      with a typed code.
  12. **F-22 → A.** window.close `counts?` = typed discriminated object per
      type aggregate; mismatch → warning `counts_mismatch` per F20 (F20's
      advisory ruling untouched).
  13. **F-25 → A.** Supersede correction = capture field set minus
      window_id/kind (inherited, immutable), fresh client_key, verified-only
      targets.
  14. **F-27 → A.** proof.attach carries client-computed content_hash of the
      original blob (stored permanently as proofs.content_hash); result =
      `{proof_id, upload: {url, method, headers, expires_at}}`;
      complete_upload verifies, then re-encodes/strips (F34) and records the
      stored-object hash in audit extras.
  15. **F-29 → A.** assignment.set = idempotent upsert to planned
      (removed→planned revival), unique (window_id, person_id); role column =
      role_class snapshot, not an input; targets = active in-workspace
      persons; A1 (assignments never authorize) restated in the slice
      contract.
  16. **F-30 → A.** Flush: per-device FIFO dispatch; network failure retries
      in place; error status retries bounded then parks; typed rejections park
      to a visible failed list (catalog-translated reason) and flushing
      continues; parked items discardable only by explicit user action.
  17. **F-31 → A.** Outbox partitioned by (auth_user_id, workspace_id); only
      a matching live session flushes a partition; refresh failure leaves
      items queued behind a re-login banner; other identities' partitions are
      inert and never auto-flushed or auto-purged.
  18. The 20 implementation-detail findings (sweep §3) are confirmed as
      smallest-safe rules; implementing agents apply them without
      re-derivation and log them as DECISIONS.md one-liners per AGENTS.md
      AMBIGUITY.
- Why this needs human sign-off: items 1–2, 4–6, 9–10, 12–15 fix stored data
  formats and the exported public API/MCP surface; items 3, 11 fix fulfillment
  computation and state-machine transitions on the billing-grade trail; item
  8 fixes a cached who-can-see-what read surface; items 16–17 fix visible
  offline behavior and audit attribution. PRODUCT, DOMAIN, ACTION kernel,
  AUDIT, PRIVACY/PII, and SECURITY/AUTHZ categories from the AGENTS.md STOP
  list are all touched; none qualifies as an implementation detail.
- Approved by: Vitali Voinski (operator), 2026-07-12; proposal authored by the architect (Fable), transcribed by the implementing agent.
- Architecture impact: amends §3 (`execution_records` gains `note text?` —
  the migration rides the SLICE-016 implementation PR, not this doc-PR; jsonb
  shapes for `commitments.verification`, `execution_windows.requirements`,
  and `execution_windows.fulfillment` documented); amends §4 (window machine
  gains system recompute transitions fulfilled↔shortfall and
  missed→fulfilled/shortfall); amends §5 (`commitment.draft`,
  `commitment.update_spec`, `record.capture`, `window.close`,
  `record.supersede`, `proof.attach`, and `assignment.set` input rows
  concretized to the exact contracts above); annotates §8/§10/§11 (day-pack
  schema, outbox failure/partition semantics). DEC-015 item 2 already resolves
  draft-site visibility; item 8 is consistent with it and carries nothing
  forward. PROGRESS.md is unchanged.

### DEC-017 — 2026-07-12 — SLICE-012 verification defaults and service-scope latest-record ordering

- Status: RESOLVED
- Raised by: SLICE-012 implementation preflight; no SLICE-012 code written.
- Question: DEC-016 and amended §3 fix the verification JSON shape and make
  `commitment.draft.verification` optional with a per-type default, but do not
  specify the default proof demand for coverage, output, or service_scope.
  Amended §3 also makes service_scope fulfillment depend on the latest
  verified service_confirmation proof without defining the ordering or a
  deterministic tie-breaker. What exact defaults and ordering apply?
- Options considered:
  1. Default every type to `{proof: {required: false, types: [], min_count:
     0}}`; choose the latest service_confirmation by `occurred_at`, then
     `received_at`, then record id. Pick this for least proof friction and
     event-time semantics, accepting that delayed/offline facts can replace a
     more recently received checklist.
  2. Require one photo by default for every type; choose the latest by
     `received_at`, then record id. Pick this for uniform evidentiary strength
     and server-observed ordering, accepting proof/upload work for coverage
     and output and that sync order decides service completion.
  3. Specify distinct proof defaults per type (including the exact
     required/types/min_count tuple for each); choose the latest by immutable
     record creation/receipt order with a named deterministic tie-breaker.
     Pick this when the three operational promises require different evidence
     policies and server arrival order should govern corrections.
  4. Specify distinct proof defaults per type; choose the latest by
     `occurred_at` with a named deterministic tie-breaker. Pick this when event
     time should govern despite offline arrival order.
- Smallest-safe default (if allowed to proceed): none — hard blocked.
- Why this needs human sign-off: DOMAIN behavior and stored-format semantics
  are affected. The default is persisted in `commitments.verification` and
  later frozen into window requirements; choosing it incorrectly either
  permits fulfillment without intended evidence or imposes unapproved proof
  collection. The ordering choice can make the same immutable checklist facts
  produce opposite fulfillment results, affecting shortfall state and the
  billing-grade audit trail.
- Resolution:
  1. Default verification tuple: for all three commitment types, proof
     is not required by default — the canonical verification shape
     defaults to proof.required=false with no kind/min_count; any
     proof requirement must be stated explicitly in commitment.draft
     input. service_scope's checklist completion remains its intrinsic
     verification core (DEC-016 item 4); proof gating is opt-in for it
     exactly as for coverage and output.
  2. "Latest verified" service confirmation ordering: total order over
     verified, non-superseded, non-voided records only (DEC-016 item
     2), by occurred_at DESC, tie-broken by received_at DESC, then id
     DESC (UUIDv7 creation order). Domain time governs; transport
     arrival never decides fulfillment. Encode this comparator once in
     core/domain and reuse it in every consumer (SLICE-016/017) —
     never re-derive per call site.
- Architecture impact: concretizes DEC-016 items 2/4/5 at
  implementation level; no ARCHITECTURE.md text amendment; the
  comparator location is an implementation contract recorded here.
- Approved by: Vitali Voinski (operator), 2026-07-13; proposal reviewed by the judge (Claude), transcribed by the implementing agent.

### DEC-018 — 2026-07-13 — SLICE-012 commitment type-definition audit version format

- Status: RESOLVED
- Raised by: SLICE-012 implementation preflight after DEC-017 resolution; no
  SLICE-012 implementation code written.
- Question: §5 requires the `commitment.draft` audit extras to carry the
  "type-def version", but does not fix the logged field name or value shape.
  What exact append-only audit-extras representation is required?
- Options considered:
  1. `{type_definition_version: 1}`. Pick this for the smallest scalar format;
     the commitment type is already present in the audited full-row `after`
     value, so duplicating it in extras is unnecessary.
  2. `{type_definition: {type: "coverage"|"output"|"service_scope", version:
     1}}`. Pick this for a self-contained audit extra that can be interpreted
     without joining or inspecting the `after` row, accepting duplicated type
     data.
  3. `{type_definition_version: "coverage@1"|"output@1"|"service_scope@1"}`.
     Pick this for one portable registry identifier, accepting a string
     encoding that consumers must parse.
- Smallest-safe default (if allowed to proceed): none — hard blocked.
- Why this needs human sign-off: AUDIT model and logged fields are affected.
  Audit events are append-only and later report/reconstruction consumers must
  read one stable representation; choosing the wrong shape creates permanent
  incompatible history that cannot be rewritten under §6.
- Resolution:
  1. The §5 type-def-version audit extra is
     `{type_definition: {type: <commitment type>, version: <integer>}}`.
     All three definitions ship at version 1. A version bump requires
     a DEC (definition changes alter fulfillment semantics on the
     audit trail).
  2. Standing convention for this and future audit extras: structured
     snake_case objects, never packed strings requiring parsing. Where
     an extras question only names/shapes information already fully
     present in the same event's `after` payload, it is an
     implementation detail under this convention (one-liner, not a
     CHANGE-REQUEST); only extras carrying NEW information not in
     `after`/`before` remain stored-format stops.
- Approved by: Vitali Voinski (operator), 2026-07-13; proposal reviewed by the judge (Claude), transcribed by the implementing agent.

### DEC-019 — 2026-07-13 — SLICE-013 commitment lifecycle public contract and completion scope

- Status: RESOLVED
- Raised by: SLICE-013 implementation preflight; no SLICE-013 implementation
  code written.
- Question:
  1. Which public action owns the `paused -> active` transition? The binding
     §4 table assigns it to `commitment.activate`, while the SLICE-013 task
     requires a fifth new action named `commitment.resume` and five appended
     §21.2 names/fixtures.
  2. Must `commitment.pause` and `commitment.archive` accept a required
     `reason`? The §5 catalog groups pause/complete/archive under input
     `id, reason`, while the SLICE-013 task requires minimal
     `{commitment_id}` input for each lifecycle action.
  3. What are the exact public rejection codes for wrong-from-state,
     state-forbidden patches, inactive-site activation, and open-window
     archive guards? The task requires new typed/catalog-translated
     rejections but does not name their API-visible codes.
  4. Is this slice complete after only update_spec/activate/pause/resume/archive
     with no UI, or must it also satisfy PROGRESS.md's unchanged Done-when by
     shipping commitment.complete, the valid_to system tick, and manager forms?
     The task says its five-action scope is exact and explicitly excludes UI,
     but also requires the PROGRESS.md Done-when verbatim and checking the
     slice complete at merge-readiness.
- Options considered:
  1. Paused-to-active action:
     - Keep §4 verbatim: `commitment.activate` accepts both `draft` and
       `paused`; do not register `commitment.resume`. Pick this to preserve the
       current architecture and avoid an alias, but it produces four rather
       than five new public action names and contradicts the task brief.
     - Amend §4/§5 so `commitment.activate` is draft-only and
       `commitment.resume` owns paused-to-active. Pick this for explicit
       lifecycle verbs and the requested five-name surface, accepting a new
       public action contract.
     - Register `commitment.resume` as an alias while retaining paused support
       in `commitment.activate`. Pick this for compatibility with both texts,
       accepting two public commands for one transition and a widened action
       surface.
  2. Lifecycle reason input:
     - Require `{commitment_id, reason}` for pause/archive as §5 says. Pick
       this for an explicit human rationale on the audit trail, accepting that
       the task's minimal-input contract and fixtures must change.
     - Amend §5 so pause/archive take only `{commitment_id}`. Pick this for the
       task's smallest input and no new logged information, accepting removal
       of a catalog-required field.
     - Require a reason for only one of pause/archive. Pick this if the
       operator considers one transition consequential enough to explain and
       the other self-describing; name which action requires it.
  3. Typed rejection surface:
     - Add distinct codes `commitment_wrong_state`,
       `commitment_patch_forbidden`, `commitment_site_inactive`, and
       `commitment_has_open_windows`. Pick this for stable, specific client
       handling with one state code and one patch code shared across fields.
     - Reuse `validation_failed` for all four guards. Pick this for no public
       enum/catalog widening, accepting that clients cannot name or distinguish
       the violations as the task requests.
     - Provide a different exact code set. Pick this if clients need finer
       distinctions (for example per transition or per forbidden field); list
       every code because the response/catalog surface is frozen by usage.
  4. Slice completion boundary:
     - Treat this PR as the exact five-action backend-only task and leave
       SLICE-013 unchecked until complete/auto-complete/forms ship separately.
       Pick this to honor the explicit exclusions, accepting that this PR is
       not the whole PROGRESS slice and cannot claim its Done-when.
     - Expand this PR to include commitment.complete, the valid_to system tick,
       and manager forms. Pick this to satisfy the current PROGRESS Done-when,
       accepting a direct expansion beyond the task's exact scope/exclusions.
     - Amend PROGRESS.md through an approved-decision docs PR so the five-action
       backend scope is the complete slice and move complete/auto-complete/forms
       to named later slices. Pick this to keep the implementation brief exact;
       identify the destination slices and provide verbatim amendment diffs.
- Smallest-safe default (if allowed to proceed): none — hard blocked.
- Why this needs human sign-off: PRODUCT behavior, ACTION kernel/public API
  surface, AUDIT model, and visible error responses are affected. Guessing can
  create duplicate transition commands, omit a required rationale from the
  append-only audit history, freeze incompatible client-visible rejection
  codes, or falsely mark a vertical slice complete while architecture-required
  actions and UI remain absent.
- Resolution:
  - Preserve the §4 state machine: commitment.activate owns both draft →
    active and paused → active; no commitment.resume action is introduced.
  - Preserve §5 inputs: pause, complete, and archive require {commitment_id,
    reason}. The valid-to system invocation supplies a canonical system reason
    and uses natural key commitment.complete:{commitment_id}.
  - Add public rejection codes commitment_wrong_state,
    commitment_patch_forbidden, commitment_site_inactive, and
    commitment_has_open_windows, each with complete catalog translations.
  - Implement the complete existing SLICE-013 scope in one PR: update_spec,
    activate, pause, complete, archive, valid-to auto-completion, manager
    forms with RRULE presets, German catalog, and tests. Mark SLICE-013
    complete only when its existing Done-when is satisfied.
  - This resolution requires no ARCHITECTURE.md or PROGRESS.md scope
    amendment.
- Architecture impact: none; preserves §4, §5, and the existing PROGRESS.md
  SLICE-013 scope while fixing the public rejection codes.
- Approved by: Vitali Voinski (operator), 2026-07-13; transcribed verbatim by
  the implementing agent.

### DEC-020 — 2026-07-13 — RLS-safe tenant discovery for commitment auto-completion cron

- Status: RESOLVED
- Raised by: SLICE-013 implementation preflight after DEC-019 resolution; no
  SLICE-013 implementation code written beyond decision transcription.
- Question: How does the daily valid-to cron discover due active/paused
  commitments across workspaces before it can dispatch the tenant-scoped
  `commitment.complete` action? DEC-016 item 18/F-09 requires a daily scan
  using each workspace timezone, but every current application DB pool assumes
  the RLS-bound `app_kernel` role and tenant policies reveal no workspace row
  until `app.workspace_id` is already known. There is no existing global
  scheduler read or SECURITY DEFINER function for tenant discovery.
- Options considered:
  1. Add a narrowly scoped SECURITY DEFINER function in a new migration that
     returns only `{workspace_id, commitment_id}` for active/paused
     commitments whose `valid_to` is before that workspace's local date, grant
     EXECUTE only to `app_kernel`, pin an empty search_path, and dispatch each
     result through the kernel with its tenant system actor and natural key.
     Pick this for database-enforced minimal disclosure and timezone-correct
     discovery, accepting a post-Phase-0 migration and a new frozen security
     function.
  2. Add a privileged server-only cron DB pool that does not assume
     `app_kernel`, scans due commitments/workspace settings across RLS, and
     uses the ordinary kernel only for mutations. Pick this to avoid a schema
     migration, accepting a broad RLS-bypassing read capability and a second
     database privilege mode in application code.
  3. Require the cron caller to supply one `workspace_id`, run the scan under
     that workspace GUC, and arrange external per-workspace fan-out. Pick this
     to preserve strict RLS and avoid privileged discovery, accepting external
     scheduler state and an API input not defined by the architecture.
  4. Defer the route/fan-out and ship only `commitment.complete` plus a pure
     per-workspace completion helper. Pick this to avoid choosing an access
     model now, accepting that SLICE-013's required automatic valid-to behavior
     and Done-when remain incomplete.
- Smallest-safe default (if allowed to proceed): none — hard blocked.
- Why this needs human sign-off: SECURITY/AUTHZ and TENANCY are affected.
  Choosing incorrectly either grants application code cross-tenant visibility,
  weakens the RLS-only access posture, exposes workspace identifiers through a
  new scheduler surface, or leaves required state transitions undispatched.
- Resolution: Add a narrowly scoped `SECURITY DEFINER` function via migration
  that returns only due `{workspace_id, commitment_id}` pairs for the daily
  completion cron (option 1). The function grants only the discovery needed
  to dispatch each completion through the ordinary tenant-scoped kernel.
- Architecture impact: authorizes the SLICE-013 post-Phase-0 migration and
  narrowly scoped SECURITY DEFINER due-commitment discovery function; no
  privileged application pool or external tenant-fan-out contract.
- Approved by: Vitali Voinski (operator), 2026-07-13; transcribed by the
  implementing agent.

### DEC-021 — 2026-07-13 — Canonical valid-to auto-completion reason

- Status: RESOLVED
- Raised by: SLICE-013 implementation preflight after DEC-020 resolution; no
  SLICE-013 implementation code written beyond decision transcription.
- Question: What exact string must the daily system invocation persist as the
  required `reason` in `commitment.complete` input when `valid_to` has passed?
  DEC-019 requires a canonical system reason but does not fix its stored value.
- Options considered:
  1. `valid_to_reached`. Pick this for a locale-neutral stable machine token
     that report/audit consumers can compare without parsing prose.
  2. `Commitment valid_to reached`. Pick this for immediately readable English
     history, accepting locale-specific prose in stored invocation input.
  3. `Gültigkeitsende erreicht`. Pick this for German-first operator history,
     accepting localized stored data and future translation/comparison issues.
  4. Provide another exact string. Pick this if an existing external audit or
     reporting vocabulary must be matched; the value must be supplied
     verbatim.
- Smallest-safe default (if allowed to proceed): none — hard blocked.
- Why this needs human sign-off: stored-format and AUDIT model semantics are
  affected. `action_invocations.input` is permanent replay history; changing
  the canonical reason later would split equivalent system completions across
  incompatible stored values and make exact audit/report filtering unstable.
- Resolution: The exact persisted system reason is `valid_to_reached`.
- Architecture impact: none expected; concretizes DEC-019's canonical system
  reason without changing the state machine or action input shape.
- Approved by: Vitali Voinski (operator), 2026-07-13; transcribed verbatim by
  the implementing agent.

### DEC-022 — 2026-07-13 — Persistence location for commitment lifecycle reasons

- Status: RESOLVED
- Raised by: SLICE-013 focused-test verification after DEC-021 resolution.
  Lifecycle code currently passes the approved reason into the action, but no
  audit/storage representation has been added.
- Question: Where must `commitment.pause`/`complete`/`archive` reasons,
  including the exact system value `valid_to_reached`, be persisted? The
  existing `action_invocations` table stores only `input_hash`, not action
  input, and §5 currently declares no audit extras for these actions.
- Options considered:
  1. Persist `{reason: input.reason}` in audit extras for every successful
     pause/complete/archive. Pick this for the existing `person.deactivate`
     precedent and one queryable audit representation for human and system
     reasons, accepting a §5 audit-extras concretization for the commitment
     lifecycle row.
  2. Persist `{reason: "valid_to_reached"}` only for system auto-completion.
     Pick this to satisfy DEC-021 with the smallest new history, accepting that
     required human reasons remain hash-only and the same action has
     actor-dependent audit shape.
  3. Add an `input jsonb` column to `action_invocations` and persist every
     action input. Pick this for complete replay/debug visibility, accepting a
     broad frozen-schema and privacy expansion far beyond SLICE-013.
  4. Treat the existing `input_hash` as sufficient persistence and store no
     readable reason. Pick this for zero audit/schema widening, accepting that
     the exact DEC-021 value cannot be recovered, displayed, or filtered from
     stored history.
- Smallest-safe default (if allowed to proceed): none — hard blocked.
- Why this needs human sign-off: AUDIT model, stored format, and potentially
  PRIVACY/PII are affected. Guessing either creates a new append-only audit
  field, broadens permanent invocation storage, or claims a reason is
  persisted when only a non-reversible hash exists.
- Resolution: Persist `{reason: input.reason}` in audit extras for every
  successful `commitment.pause`, `commitment.complete`, and
  `commitment.archive` execution (option 1).
- Architecture impact: concretizes the §5 audit extras for the three
  reason-bearing commitment lifecycle actions; no schema change.
- Approved by: Vitali Voinski (operator), 2026-07-13; transcribed verbatim by
  the implementing agent.

### DEC-023 — 2026-07-13 — Window cron discovery, guards, and timezone resolution

- Status: RESOLVED
- Raised by: SLICE-014 implementation brief before answer-dependent code.
- Question: How must cross-tenant window generation/open cron discovery,
  window state and supervisor-scope rejections, and workspace-local DST/RRULE
  resolution work when implementing `window.generate` and `window.open`?
- Options considered:
  1. Add two narrow `SECURITY DEFINER` discovery functions following DEC-020,
     add `window_wrong_state`, enforce supervisor site scope inside each window
     action, and fix deterministic DST behavior (gap shifts forward; overlap
     uses the earlier offset), with established timezone and RRULE libraries
     allowed. Pick this for least-privilege discovery, action-local fresh scope
     checks, typed state failures, and stable cross-runtime schedule behavior,
     accepting one authorized migration and one public rejection-code addition.
  2. Give cron a privileged cross-tenant database pool and perform supervisor
     scope in `authorize.ts`. Pick this for fewer database functions and a
     centralized authorization check, accepting a broad RLS bypass and changes
     to the frozen authorization layer without a window row/site context there.
  3. Require external per-workspace cron fan-out and reuse
     `validation_failed` for window state. Pick this to avoid privileged
     database discovery and a rejection enum addition, accepting scheduler
     tenant state outside the application and no typed state distinction for
     clients.
  4. Use PostgreSQL/runtime defaults for ambiguous and nonexistent local times
     and defer RRULE parse failures to generic cron errors. Pick this for no
     timezone/RRULE dependency, accepting environment-dependent instants and a
     single malformed stored commitment aborting autonomous generation work.
- Smallest-safe default (if allowed to proceed): none — hard blocked.
- Why this needs human sign-off: SECURITY/AUTHZ, TENANCY, ACTION kernel,
  DOMAIN behavior, stored timestamps, and visible rejection surfaces are
  affected. A wrong choice can expose cross-tenant identifiers broadly, make
  supervisor authority stale or over-broad, store different instants for the
  same wall clock, or destabilize autonomous cron processing.
- Resolution:
  1. Cron tenant discovery for window generation and opening: one new
     migration (0009) adds two narrow SECURITY DEFINER functions per the
     DEC-020 pattern — app_generatable_commitments() returning {workspace_id,
     commitment_id} for active commitments on active workspaces
     (valid-date-range overlapping the horizon), and
     app_due_scheduled_windows() returning {workspace_id, window_id} for
     scheduled windows with starts_at <= now(). Both: LANGUAGE sql STABLE
     SECURITY DEFINER SET search_path='', REVOKE PUBLIC, GRANT EXECUTE to
     app_kernel. Discovery only; every mutation dispatches through the
     tenant-scoped kernel with its natural key.
  2. New rejection code window_wrong_state (frozen types.ts touch authorized)
     for state-guard violations on window actions; supervisor site-scope
     violations reuse the existing unauthorized code — no per-cause window
     code.
  3. Supervisor site-scope enforcement for window actions is a domain guard
     inside the action execute: an S actor may act only on windows whose site
     is in sites.settings.supervisor_person_ids, resolved fresh per request
     (F12; never cached, never an authz-layer change — authorize.ts stays
     frozen).
  4. DST resolution for wall-clock → timestamptz conversion in the workspace
     tz: nonexistent local times (spring-forward gap) shift forward to the
     first valid instant; ambiguous local times (fall-back) resolve to the
     earlier offset. Record as the standing rule; an established tz library
     may be added as a dependency (one-liner naming it); RRULE parsing may
     likewise use an established library — RRULE semantic validation happens
     here at generation (the SLICE-012 one-liner's deferred boundary), with
     an unparseable stored rrule producing a typed validation_failed per
     generated commitment, never a cron crash.
- Architecture impact: authorizes migration 0009, the two DEC-020-pattern
  discovery functions, the `window_wrong_state` public rejection code, the
  action-local supervisor site guard, and the stated timezone/RRULE rules for
  SLICE-014.
- Approved by: Vitali Voinski (operator), 2026-07-13; proposal authored by the judge (Claude), transcribed by the implementing agent.

### DEC-024 — 2026-07-13 — Persistence location for execution-window open time

- Status: RESOLVED
- Raised by: SLICE-014 implementation preflight after DEC-023 transcription;
  no answer-dependent implementation code written.
- Question: Where must `window.open` persist the required `opened_at` value?
  The SLICE-014 brief requires the action to “record[] opened_at”, but the §3
  `execution_windows` row and frozen migration/schema contain no `opened_at`
  column, and DEC-023 authorizes migration 0009 for two discovery functions
  without authorizing an execution-window stored-format change.
- Options considered:
  1. Add nullable `execution_windows.opened_at timestamptz` in migration 0009,
     mirror it in `core/db/schema.ts`, set it exactly once on scheduled → open,
     and include it in the window before/after audit snapshots. Pick this for a
     directly queryable current-state timestamp with explicit relational
     semantics, accepting a post-Phase-0 frozen-schema change in the migration
     already authorized by DEC-023.
  2. Treat the successful `window.open` audit event's `at` as the authoritative
     open time and add no window column. Pick this for zero schema widening,
     accepting that `opened_at` is not a field on the window row and consumers
     must derive it from append-only audit history.
  3. Store `opened_at` inside `execution_windows.fulfillment` or
     `requirements`. Pick this to avoid a relational column while keeping the
     value on the row, accepting contamination of §3's frozen JSON contracts
     with metadata neither object defines.
  4. Do not persist a distinct open time; rely on `starts_at` for cron opens
     and invocation/audit timing for early opens. Pick this only if “records
     opened_at” was non-binding prose, accepting loss of an exact normalized
     open timestamp and ambiguity for early-open reporting.
- Smallest-safe default (if allowed to proceed): none — hard blocked.
- Why this needs human sign-off: DOMAIN model and stored-format/frozen-schema
  scope are affected. Guessing can create an unauthorized schema/API contract,
  corrupt the meaning of frozen requirements/fulfillment JSON, or omit a
  timestamp explicitly required by the task and later reads/reports.
- Resolution:
  1. Option 2. `window.open` persists no distinct `opened_at` value: the
     scheduled → open status transition plus the `window.open` audit event
     (whose `at` is the authoritative opening time) constitute the complete
     record. The task wording “records opened_at” is withdrawn as a
     judge-brief error — it named a field the architecture never defined.
     Migration 0009 remains exactly the two DEC-023 discovery functions; no
     schema column is added.
  2. Standing rationale, recorded for future analogous questions: under
     DEC-015 item 3, event timing facts (when did X transition happen) live in
     `audit_events` and are consumed via audit-derived reads; a dedicated
     column is justified only when a §3/DEC contract or read schema names it
     as row state. Questions of this shape resolve to the audit event by
     default.
- Architecture impact: confirms that `window.open` changes only window status
  and records its transition time through the existing audit event; migration
  0009 and the frozen execution-window row shape remain unchanged.
- Approved by: Vitali Voinski (operator), 2026-07-13; proposal reviewed by the judge (Claude), transcribed by the implementing agent.

---

## Implementation-detail notes (one-liners per AGENTS.md AMBIGUITY; details in each PR's "Decisions made")

- 2026-07-13 SLICE-014A (DEC-016 F-13): seed replay no-op is evaluated at one injected `Temporal.Instant`; a later instant appends only newly-in-horizon windows through their `window.generate:{commitment_id}:{date}` natural keys and never duplicates or mutates existing fixtures.
- 2026-07-13 SLICE-014 (DEC-018/023/024): pinned `@js-temporal/polyfill@0.5.1` resolves workspace-local gaps/overlaps and `rrule@2.8.1` expands date-only recurrences anchored to `valid_from`; `window.generate` initializes `fulfillment` through the type definition with zero verified records and logs `{frozen_targets: {target_qty, unit, requirements}}`; generation runs daily at 00:00 UTC and due-window opening every minute.
- 2026-07-13 SLICE-014: additive read-only helpers (workspaceTimeZone, windowCronCommitment) were added to existing frozen core/db modules because entity queries belong in their entity module; the frozen-path rule is amended operator-side to: existing core/db files admit additive, read-only, pattern-following helpers recorded per PR — behavioral or write-path changes remain CHANGE-REQUEST.
- 2026-07-13 SLICE-013 (DEC-016 item 18, DEC-018/019/020): activation audit extras use `{frozen_spec_hash}` over the canonical type/spec/schedule/target/unit/verification/validity snapshot; `commitment.update_spec` accepts `type`/`site_id` only as rejection sentinels so immutable-field attempts return DEC-019's typed code; the approved discovery function is `app_due_commitments()`, mounted at `/api/cron/commitments/complete` daily at 01:00 UTC; manager forms expose only the four F-08 RRULE presets at `/dashboard/commitments`.
- 2026-07-13 SLICE-012 (DEC-016 F-05/F-11, DEC-017): commitment.draft stores schedule_rrule as an opaque trimmed non-empty string and defers semantic parsing to window.generate (SLICE-014); service_scope checklist keys are trimmed, non-empty, and unique so frozen-key completion is deterministic; capture-UI hints remain internal TypeScript data and are never included in stored or exported schemas.
- 2026-07-12 SLICE-011: the seed reuses `Kernel.dispatch` with a deterministic simulated owner context only for the first `person.create` bootstrap (matching the existing kernel-test actor-context pattern); every later person/client/site invocation, including human-only `site.activate`, dispatches as the returned seeded owner, pinned `tsx` exists only to run the TypeScript migration/seed entrypoints, and the local Phase 0 chain excludes only unused edge-runtime/imgproxy/realtime/Studio/vector services.
- 2026-07-12 SLICE-010 (DEC-016 F-15): `labels` flattens the root `capture` catalog namespace; the Phase 0 shell contains its current `title` key only, selects `en` only for an English person locale, and falls back to `de` otherwise.
- 2026-07-12 SLICE-010: the build-time read schema surface is the statically exported `readJsonSchemas` registry projection produced by Zod 4 from every definition's params and response schemas; no generated file or new dependency is needed.
- 2026-07-12 SLICE-009: Google invite state uses an httpOnly SameSite=Lax `ocp_google_invite_state` cookie containing a random nonce plus the bound workspace/person ids; Next `authInterrupts` renders the typed dashboard HTTP 403; authenticated role-router/surface pages are forced dynamic.
- 2026-07-05 SLICE-001: test runner = Vitest; the de.json completeness check is a Vitest test (tests/i18n.test.ts) so it wires into CI without a stray top-level scripts/ dir (§21.1).
- 2026-07-05 SLICE-001: internal core package aliased as `@core/*` (tsconfig paths); package manager = npm with committed lockfile; CI runs on Node 24 (LTS), matching the npm major that generates the lockfile.
- 2026-07-05 SLICE-001: §20.7 lint gate = `react/jsx-no-literals` scoped to app/**; §20.5 = `no-restricted-imports` (drizzle-orm, postgres, pg, @supabase/*) everywhere except core/db, plus @core/db banned inside app/.
- 2026-07-05 SLICE-001: default locale hardcoded `de` in core/i18n/request.ts until per-person locale resolution attaches with auth (SLICE-008).
- 2026-07-05 SLICE-002: §3 statuses/kinds/enums as native Postgres enum types; action_invocations gets its own invocation_actor_type enum ('person','agent','system','platform') per DEC-005 while audit_events keeps §3's exact 3-value actor_type; invocation_status includes 'pending' (F30).
- 2026-07-05 SLICE-002: nullability follows §3's "?" markers except where architecture-internal consistency forces NULL: execution_windows.target_qty/unit (frozen copies of nullable commitment fields, A3), auth_devices.last_seen_at (no value before first request), action_invocations.result (row inserted pending, F30).
- 2026-07-05 SLICE-002: single-column actor fields (captured_by_actor, source_actor, generated_by_actor) stored as jsonb {actor_type, actor_id}; commitments.valid_from/valid_to as date; idempotency_key text (deterministic natural keys, §5), client_key uuid (§5 "client uuid (= client_key)"); no verified_by column on execution_records — §12 defines the CSV's verified_by as the capturing actor (F32), i.e. captured_by_actor.
- 2026-07-05 SLICE-002: unique indexes beyond §3's explicit ones, each a lookup-path necessity: workspaces.slug, auth_devices.token_hash and report_shares.token_hash (hashed-token resolution precedes workspace context, §12/§16), partial unique persons(workspace_id, auth_user_id) (F11 "unique per workspace").
- 2026-07-05 SLICE-002: RLS = uniform SELECT/INSERT/UPDATE policies TO app_kernel (created NOLOGIN) comparing workspace_id to the app.workspace_id GUC, failing closed when unset; workspaces compares its own id; plans is read-only-global; no DELETE grant or policy on any table (nothing hard-deletes, §3); audit_events gets SELECT/INSERT only.
- 2026-07-05 SLICE-002: migrations = sequential SQL in db/migrations applied by core/db/migrate.ts (one transaction per file), tracked in public.schema_migrations (RLS-enabled, no policies, invisible to app_kernel); the sandbox has no Docker daemon for `supabase start`, so SQL tests provision embedded PostgreSQL 17 (real Postgres, devDependencies embedded-postgres + pg + @types/pg), with TEST_DATABASE_URL as the local-Supabase override.
- 2026-07-06 SLICE-003 (operator-confirmed): the DEC-005 platform replay lookup runs through a SECURITY DEFINER function `app_platform_invocation_lookup(key)` (STABLE, empty search_path, schema-qualified, EXECUTE granted to app_kernel only) — one auditable query shape (exact key + actor_type='platform') instead of a GUC-gated policy carve-out whose ambient session state would weaken the tenant SELECT policy for every query on the table; strict RLS policies stay untouched.
- 2026-07-06 SLICE-003 (operator-confirmed): first `plans` row ('pilot', empty limits/price, inert while the Phase 0 entitlement resolver is noop-unlimited) is inserted by migration — plans is global reference config with a stable text code PK (F9), outside DEC-004's kernel-replay rule, which exists for tenant fixtures (audit trail + state machines); pulling plan.set forward from Phase 5 for one row would drag entitlement semantics into Phase 0.
- 2026-07-06 SLICE-003: rejected invocations persist as status='rejected' rows with the stored envelope so rejections replay byte-identically; two deterministic exceptions return unpersisted envelopes — input-hash-mismatch (F24: the key belongs to the original row) and platform pre-execution rejections (no tenant root exists for the NOT NULL workspace_id).
- 2026-07-06 SLICE-003: byte-identical replay (F24) = the kernel returns the RETURNING value of the response-envelope UPDATE, so the first response and every replay serialize the identical stored jsonb; input_hash = sha256 over canonical JSON (sorted keys), making replay matching key-order independent.
- 2026-07-06 SLICE-003: agent invocations of proposal_gated actions are typed rejections (mutation-free) until SLICE-034 delivers AgentProposal conversion (F2); threshold classes otherwise pass humans/system/platform through to the role matrix.
- 2026-07-06 SLICE-003: kernel connections assume app_kernel via the connection startup parameter (options="-c role=app_kernel"); deployments grant the login role membership in app_kernel WITH SET (PG16+ semantics), which the test harness self-grants after migrating.
- 2026-07-06 SLICE-003: new dependencies — zod@4 (runtime, §5 validation), uuid@13 (runtime, app-generated UUIDv7 §3), supabase@2 (dev, local stack config under db/supabase via --workdir db); drizzle deferred until a slice needs typed domain queries — core/db stays the only db import site (§20.5).
- 2026-07-06 SLICE-003 (operator-confirmed, structural): data-access split for all future slices — the kernel's bookkeeping (invocation insert/update/select, audit insert, GUC set_config, the DEC-005 lookup call: six fixed statements inside the soon-frozen pipeline modules) stays raw SQL permanently; domain CRUD adopts Drizzle starting SLICE-005, which adds a core/db/schema.ts mirror of all 22 §3 tables plus a **required CI gate** asserting Drizzle-schema ↔ information_schema parity, so drift between db/migrations and the mirror fails the build. §19's map comment ("drizzle schema, client, GUC helper") names the library in the one place the architecture mentions an ORM; this note fixes how it applies. Confirmed by Vitali Voinski (operator), 2026-07-06.
- 2026-07-06 SLICE-003: HTTP mapping for the §5 envelope — ok 200, error 500, rejected 401 (unauthenticated) / 403 (unauthorized) / 409 (idempotency_conflict) / 400 otherwise; POST /api/actions resolves no actor until SLICE-008/009 attach session/device auth, so it returns the typed unauthenticated rejection without reaching the kernel.
- 2026-07-06 SLICE-004: the §20.4 Storage-path check = unit tests over a new pure module core/db/storage-path.ts (build/parse/authorize for §7's [FIXED] `ws/{workspace_id}/…` prefix, fail-closed parsing: canonical lowercase uuid, no empty/dot/dotdot segments) — no Storage I/O exists in Phase 0 and the CI database harness has no Storage service, so the prefix mechanism itself is the testable tenancy boundary; later Storage writers (proof.attach, report.generate, doc.upload) must build and authorize paths only through this module.
- 2026-07-08 SLICE-008: auth route names and cookie names are implementation wiring (`/api/auth/{magic-link,session,workspace,accept}`, `ocp_auth_token`, `ocp_workspace_id`); the pre-workspace membership lookup is confined to `core/auth` and returns only DEC-010's qualifying workspace id + display name.
- 2026-07-11 SLICE-008 pre-freeze audit: failed invite-acceptance preflight checks return directly from the session route before dispatching `person.link_auth`, preserving the natural success idempotency key for later corrected acceptance.
- 2026-07-06 SLICE-004: RLS-suite fixtures are inserted with direct SQL as the migration owner (SQL-test scaffolding precedent from SLICE-002's immutability suite; the §5 actions for these entities ship SLICE-005+); isolation is proved two ways — raw SET LOCAL ROLE app_kernel transactions per table, and a deliberately workspace-filter-free test action dispatched through the real kernel for the §7 bypass case.
- 2026-07-07 SLICE-005: workspace.create generates the UUIDv7 workspace id server-side, uses that canonical id text as the initial slug, writes only architecture-defined default settings (`tz`, `default_locale`, empty `branding`, empty `action_policies`, `retention_months`), and returns only `{workspace_id}`.
- 2026-07-07 SLICE-005: the Drizzle parity gate uses public Drizzle table metadata from the checked-in `core/db/schema.ts` mirror and compares table/column/type/nullability against `information_schema.columns` for all 22 §3 tables.
- 2026-07-07 SLICE-006: person.* ok envelopes return only `{person_id}`, matching SLICE-005's id-only result pattern; action-level guard rejections persist `status='rejected'` invocation envelopes without audit events or mutations.
- 2026-07-08 SLICE-007 (per DEC-009 Q4 "fix ... accordingly"): `clients.contact` = `{email?, phone?, note?}`, `sites.address` = `{street?, postal_code?, city?, country?}` — both single NOT NULL jsonb columns written/replaced wholesale on presence in the action input, never deep-merged (no sub-field patch semantics; matches DEC-008's flat/patch precedent at the column level, not inside a jsonb value). `sites.settings` stays exactly `{supervisor_person_ids}` in v1 — no other settings field is defined.
- 2026-07-08 SLICE-007: site.activate's meter-delta audit extras shape is `{meter_delta: {metric: "active_sites", delta, active_sites_after}}` — includes the post-transition count alongside the delta so the §9 meter is legible directly off the audit trail without re-deriving it from a `sites` scan.
- 2026-07-08 SLICE-007: `client.archive` reuses a new typed rejection `client_has_active_sites` (DEC-009 Q5 guard), same tier as SLICE-006's `last_owner_protected` — a domain-guard code, not a new capability; catalog entries added to de.json/en.json.
- 2026-07-08 SLICE-007: `site.create` requires `client_id` to reference an existing, active (non-archived) client in the same workspace — smallest-safe reference validation, mirrors `person.update`'s exclusion of pseudonymized targets. `client_id` is not a `site.update` patch field (reassigning a site's client has undefined billing/attribution consequences and is out of DEC-009's scope).
- 2026-07-08 SLICE-007: `site.archive` is registered per catalog (§21.2 exact-match) but its `execute()` deliberately throws — reuses the kernel's existing generic error path (`status="error"`, `internal_error` catalog string, no mutation, no audit event, replay-stable) already exercised by `test.fail_after_write`; no new RejectionCode was added for the deferral itself, since `RejectionCode` is a closed, catalog-declared, user-visible set (AGENTS.md STOP list) and this reuses what already exists.
- 2026-07-11 SLICE-008 residual R1: `person.invite` audit extras extend to `{auth_invite_id, invited_email}`; `person.link_auth` binds to the newest such record and fails closed for legacy invite audits without `invited_email`, requiring a re-invite.
- 2026-07-11 pre-freeze residual race fix: client/site raw `FOR UPDATE` helpers live in `core/db/clients.ts`, matching the existing `core/db/persons.ts` `lockWorkspaceForOwnerGuard` boundary while preserving behavior.
- 2026-07-12 SLICE-009 review: the `/dashboard` typed 403 relies on Next `experimental.authInterrupts` (`next.config.ts`); verify the rejection contract (rendered catalog page, HTTP 403) on every Next.js upgrade until the flag is stable.
- 2026-07-12 SLICE-009 review: auth cookies are `SameSite=Lax` deliberately — `Strict` would drop the session cookie on the Google OAuth redirect and break provider login; do not harden without a DEC.
- 2026-07-12 Phase 0 dual audit: `person.invite` dispatches the Supabase invite transport before audit commit, so a DB failure after send can leave an unaudited invitation; this is tracked debt, with the fix riding SLICE-027 or earlier as send-after-commit or record-then-send per §14.
- 2026-07-12 Phase 0 dual audit: DEC-016 F-30's “per-device FIFO” means per browser instance; DEC-013 item 5 prohibits any device or substitute client identifier, partition authority is exactly `(auth_user_id, workspace_id)`, and SLICE-021 implements per-browser-instance ordering.
- 2026-07-12 Phase 0 dual audit: §21.3's transaction may open before the gate chain so rejected invocations persist their rows (F24) and the DEC-005 replay lookup runs in-transaction; the pinned order governs the gate sequence, not the BEGIN position.
