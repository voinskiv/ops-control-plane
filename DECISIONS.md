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

---

## Implementation-detail notes (one-liners per AGENTS.md AMBIGUITY; details in each PR's "Decisions made")

- 2026-07-05 SLICE-001: test runner = Vitest; the de.json completeness check is a Vitest test (tests/i18n.test.ts) so it wires into CI without a stray top-level scripts/ dir (§21.1).
- 2026-07-05 SLICE-001: internal core package aliased as `@core/*` (tsconfig paths); package manager = npm with committed lockfile; CI runs on Node 22 LTS.
- 2026-07-05 SLICE-001: §20.7 lint gate = `react/jsx-no-literals` scoped to app/**; §20.5 = `no-restricted-imports` (drizzle-orm, postgres, pg, @supabase/*) everywhere except core/db, plus @core/db banned inside app/.
- 2026-07-05 SLICE-001: default locale hardcoded `de` in core/i18n/request.ts until per-person locale resolution attaches with auth (SLICE-008).
