# PROGRESS

Execution backbone derived from ARCHITECTURE.md v1.0 (2026-07-05). One slice = one
vertical end-to-end path (schema → handler → audit → test) = one PR, per AGENTS.md
and §19 (F8). Slices are ordered by dependency within and across phases. Check a box
only when the slice's PR is merged with its "Done when" criteria green in CI.

§20 refs are the global acceptance criteria; per-phase applicability follows the F5
map (P0 → 1–7, 12; P1/P2 → 1–8, 11, 12; P3 → +10; P4/P5 → 1–12).

## Phase 0: Foundation

- [x] SLICE-001: Repo scaffold, CI gates, i18n catalog skeleton
      Architecture ref: §19 (module map, Phase 0), §15, §20.5, §20.7
      Done when: repo tree matches the §19 map (§21.1); CI runs typecheck, lint, tests; lint enforces no-hardcoded-strings (§20.7) and no db import outside core/db, no core/db import inside app/ (§20.5); de.json + en.json catalogs exist with the de completeness check wired
      Depends on: none
      Status: merged 2026-07-05 (PR #1), Done-when green in CI.

- [ ] SLICE-002: Full v1 schema migrations + RLS policies + immutability triggers
      Architecture ref: §3, §6 (enforcement), §7, §19 Phase 0 ("full v1 schema ships in Phase 0")
      Done when: migrations apply on an empty local Supabase (§20.12 partial); every tenant table has workspace_id NOT NULL, RLS enabled, (workspace_id, …) indexes (§21.5); UUIDv7 PKs except plans text code PK (§21.4, F9); SQL tests prove audit_events rejects UPDATE/DELETE and execution_records/proofs BEFORE triggers reject non-kernel or fact-column UPDATE (§20.6, F4, F30)
      Depends on: SLICE-001

- [ ] SLICE-003: Action kernel core — registry, dispatch, idempotency, audit-in-transaction
      Architecture ref: §5, §6, §7 (app_kernel role + GUC), §21.3
      Done when: POST /api/actions dispatches through authorize → entitlement (noop-unlimited) → threshold → validate → transaction(execute + audit) → persist result (§21.3); unknown action → typed rejection and every registered action has a Zod schema (§20.1); replay on (workspace_id, idempotency_key) returns the stored envelope byte-identical with no re-execution, same key + different input_hash → typed rejection (§20.2, F24, F30); audit-per-executed-action property test iterates the registry (§20.3); kernel runs as app_kernel with per-transaction app.workspace_id GUC (F13)
      Depends on: SLICE-002

- [ ] SLICE-004: Tenancy isolation test suite (RLS backstop proof)
      Architecture ref: §7, §20.4, F13
      Done when: workspace-A actor reading/writing workspace-B rows gets zero rows/denial on ≥3 representative tables plus a Storage-path check, with RLS active, including the deliberate kernel-workspace-filter-bypass case (§20.4)
      Depends on: SLICE-003

- [ ] SLICE-005: workspace.create action
      Architecture ref: §5 catalog, §3 (workspaces, plans)
      Done when: workspace.create (platform actor, human_only) creates a workspace with plan snapshot in audit extras; audit + idempotency tests green for the action
      Depends on: SLICE-003

- [ ] SLICE-006: person actions (create / update / deactivate / pseudonymize)
      Architecture ref: §5 catalog, §3 (persons), §16 (erasure)
      Done when: all four actions execute through the kernel with catalog thresholds and audit extras (role changes, reason, GDPR basis note); pseudonymize replaces PII while history stays coherent; tests green
      Depends on: SLICE-005

- [ ] SLICE-007: client + site actions (create / update / archive; site activate / archive)
      Architecture ref: §5 catalog, §3 (clients, sites), §9 (active-site meter legibility)
      Done when: client.* and site.* actions execute with catalog thresholds; site.activate/archive are human_only and write meter-delta audit extras; sites.settings.supervisor_person_ids persists (F12); tests green
      Depends on: SLICE-005

- [ ] SLICE-008: Manager auth — magic link, session, login + authenticated shell
      Architecture ref: §16 (auth), F11, §19 Phase 0 (UI scope)
      Done when: Supabase Auth magic link (SMTP via Resend) resolves to a persons row via auth_user_id with active workspace explicit in session; one auth identity can hold roles in multiple workspaces (F11); login + bare authenticated shell render with catalog strings only
      Depends on: SLICE-006

- [ ] SLICE-009: Device auth — enroll / claim / revoke, PIN, device.touch
      Architecture ref: §5 catalog (device.*), §16, F17, Appendix B (device.touch)
      Done when: device.enroll issues single-use QR / 8-digit code expiring in 15 min; device.claim runs through the kernel as actor_type=system with code-possession + rate limit replacing authorize (F17); token/PIN stored only as hashes, token held in httpOnly cookie; device.revoke immediate; device.touch kernel-internal op updates last_seen_at idempotently; claim-flow test green (§21.10)
      Depends on: SLICE-006

- [ ] SLICE-010: Read layer mount + `me` read
      Architecture ref: §5 (reads, F29), §19 Phase 0 done-means
      Done when: GET /api/reads/:name mounts core/reads; the `me` read (empty day-pack shell) returns after a simulated device claim (Phase 0 agent-verifiable done)
      Depends on: SLICE-003, SLICE-008, SLICE-009

- [ ] SLICE-011: Seed fixture "Demo GmbH" (workspace/persons/clients/sites/devices) via kernel replay + fresh-clone command chain
      Architecture ref: §19 (db/seed, Touch rules seed ruling, DEC-004), §20.12
      Done when: fresh clone → migrations on empty db → seed replays kernel action invocations (workspace.create, person.create, client.create, site.create, device.enroll/claim) with deterministic idempotency keys — no direct SQL — → typecheck + lint + tests green via one documented command chain (§20.12); commitment/window fixtures are explicitly deferred to SLICE-014A (Phase 1); Phase 0 CI gates §20 1–7, 12 all green
      Depends on: SLICE-001 through SLICE-010 (phase integration slice)

## Phase 1: Board + capture live

- [ ] SLICE-012: Commitment type definitions (coverage, output, service_scope)
      Architecture ref: §3 (commitment type definitions, F10)
      Done when: core/domain/commitment-types/ registers the three v1 types with Zod spec schema, satisfying record kinds, fulfillment rule, shortfall triggers, and capture-UI hints per the canonical F10 mapping; proof/recovery enum values carry no v1 definition; unit tests per type
      Depends on: SLICE-003

- [ ] SLICE-013: Commitment state machine + commitment.* actions + manager forms
      Architecture ref: §4 (Commitment), §5 catalog (commitment.*), §19 Phase 1
      Done when: draft→active→paused→completed→archived transitions execute only in core/domain (§21.8); archive blocked while any window is not closed (F23); auto-complete on valid_to runs as Y with nat key; update_spec affects only later-generated windows (A3); manager forms with rrule presets ship with complete German catalog; tests green
      Depends on: SLICE-007, SLICE-012

- [ ] SLICE-014: Window generation + open — window state machine, cron, freeze
      Architecture ref: §4 (ExecutionWindow), §5 catalog (window.generate/open), §19 Phase 1
      Done when: window.generate cron (nat key, rolling 7-day horizon, timezone-correct) freezes target/requirements at generation (§21.9); window.open fires on starts_at via cron nat key plus early open; freeze test: editing an active commitment leaves generated windows untouched (§20.11); the phase done-means "tomorrow's board auto-generates in the seed" is verified in SLICE-014A, not here — claiming it in this slice would require seed commitment data this slice's own dependency (SLICE-013 only) doesn't yet guarantee
      Depends on: SLICE-013

- [ ] SLICE-014A: Phase 1 seed extension — Demo GmbH commitment/window fixtures via kernel replay
      Architecture ref: §19 (Phase 1 seed extension, Touch rules seed ruling, DEC-004)
      Done when: the seed script extends Demo GmbH by replaying commitment.draft + commitment.activate for the fixture commitments and invoking window.generate for the rolling horizon, all as kernel action invocations with deterministic idempotency keys — no direct SQL; re-running the seed is a no-op (idempotent replay); this slice fulfills the Phase 1 done-means "tomorrow's board auto-generates in the seed" (moved here from SLICE-014 to avoid a circular dependency)
      Depends on: SLICE-011, SLICE-013, SLICE-014

- [ ] SLICE-015: Day-pack read + Heute board (PWA shell)
      Architecture ref: §10, §11 (day-pack read), §8 (supervisor site scope, F12), §7 (60 s poll)
      Done when: day-pack read returns windows/assignments/persons/labels for exactly the sites in sites.settings.supervisor_person_ids (F12); Heute board renders grouped by site with frozen target + live status, polling 60 s + on focus; PWA manifest + service worker present (§21.12); German catalog complete for the surface
      Depends on: SLICE-009, SLICE-010, SLICE-014

- [ ] SLICE-016: record.capture end-to-end + capture controls + fulfillment
      Architecture ref: §4 (ExecutionRecord, F32), §5 catalog (record.capture/verify), §10, §11
      Done when: record.capture (kinds presence, coverage_confirm, output, service_confirmation, note) writes verified rows auto-verified in one audit event with device_id + clock-skew extras (F32), client_key as idempotency key; record.verify registered but unused by capture UI (F32); fulfillment recomputed on every verify/void/supersede; per-type capture controls (headcount, tap-list, stepper, checklist) ship; fulfillment unit tests per type definition green
      Depends on: SLICE-012, SLICE-015

- [ ] SLICE-017: window.close / reconcile / reopen
      Architecture ref: §4 (ExecutionWindow), §5 catalog, §11 (contended mutations, F20)
      Done when: window.close computes fulfilled/shortfall server-side from verified records only, treating the client counts summary as advisory with mismatch warning (F20); close on already-closed window returns current state + warning and audits a no-op (F24); window.reconcile by M or auto after 48 h; window.reopen (M, human-only) implemented with the report-lock precondition stubbed open until Phase 3 delivers locking reports (F14 — see SLICE-030); tests green
      Depends on: SLICE-016

- [ ] SLICE-018: record.supersede + record.void (corrections)
      Architecture ref: §4 (ExecutionRecord), §5 catalog, §6 (corrections only via supersede/void)
      Done when: supersede links supersedes_id on a new correcting record; void requires reason (M, human_only); fulfillment recomputes; SQL immutability still holds — corrections exist only via these actions (§20.6)
      Depends on: SLICE-016

- [ ] SLICE-019: Proofs — attach, deferred upload, complete_upload, upload_failed
      Architecture ref: §3 (proofs), §5 catalog (proof.*), §11 (photo sync), §16 (EXIF strip, F34), Appendix B (proof.upload_failed)
      Done when: proof.attach issues an upload slot with content hash; record syncs first with proof pending_upload; proof.complete_upload re-encodes and strips EXIF/GPS server-side before leaving pending_upload (F34); proof.upload_failed kernel-internal op sets failed; camera-first capture UI where requirements demand; tests green
      Depends on: SLICE-016

- [ ] SLICE-020: assignment.set / remove + quick-set UI
      Architecture ref: §3 (assignments), §5 catalog, §8 (A1: assignments drive board content and no-show detection, never authz)
      Done when: assignment.set/remove (autonomous_safe) execute with audit; manager quick-set UI ships; assignments appear in the day-pack and board rows; tests green
      Depends on: SLICE-006, SLICE-015

- [ ] SLICE-021: Offline outbox + batch confirm + Phase 1 e2e
      Architecture ref: §11, §10 (batch confirm), §19 Phase 1 done-means, §20.8
      Done when: IndexedDB outbox queues invocations (payload + idempotency key + occurred_at), flushes FIFO on reconnect/background sync; e2e records a window airplane-mode offline→synced in ≤3 taps from the Heute board; zero duplicate records under forced retry (§20.8); batch confirm per site works; German catalog complete for all Phase 1 surfaces; §20 1–8, 11, 12 green
      Depends on: SLICE-016, SLICE-017, SLICE-019

## Phase 2: Exceptions / escalation / recovery

- [ ] SLICE-022: Exception state machine + manual raise + exception views
      Architecture ref: §4 (Exception, F16 manual raises), §5 catalog (exception.raise), §19 Phase 2, Appendix A (per-severity due offsets)
      Done when: exception machine (open→owned→recovering→resolved→closed, cancelled) lives in core/domain; manual exception.raise (S/M, incl. client_complaint) takes type/severity/due_at from the form, defaulting due_at to raise + per-severity offset; inline PWA raise ("Fehlt jemand?" → pre-filled no_show) and dashboard exception views ship; tests green
      Depends on: SLICE-016, SLICE-020

- [ ] SLICE-023: exception.claim / assign (CAS) + exception.cancel
      Architecture ref: §4, §5 catalog, §11 (CAS conflict → UI refresh)
      Done when: claim/assign compare-and-set on owner; conflicting claim returns a typed conflict and the UI refreshes; cancel (M, reason required); CAS conflict test green (Phase 2 test list)
      Depends on: SLICE-022

- [ ] SLICE-024: RecoveryAction lifecycle + exception.close
      Architecture ref: §4 (RecoveryAction, F15), §5 catalog (recovery.*, exception.close)
      Done when: proposed→approved→in_progress→done per F15; manager self-created recovery may skip approve; supervisors start/complete only approved recoveries; recovery.cancel (M, reason); exception.close requires ≥1 recovery in done; resolved auto-closes after 7 days (Y); tests green
      Depends on: SLICE-023

- [ ] SLICE-025: Detector crons → auto-raised exceptions
      Architecture ref: §4 (detector mapping F16, window missed transition), §19 Phase 2, Appendix A
      Done when: missed-window (0 verified records by ends_at + 30 min grace → window missed + no_show sev 3), coverage/output shortfall on close (sev 2), missing_proof timeout (24 h, sev 1), unstaffed window at T-minus 60 min (no_show sev 3, due_at = starts_at) all raise exactly one open exception per seed scenario with deterministic nat keys ({rule}:{window_id}); shortfall/missed windows auto-raise per §4; phase done-means "exactly one open exception" green
      Depends on: SLICE-017, SLICE-019, SLICE-020, SLICE-022

- [ ] SLICE-026: Escalation rule management + escalation.tick + acknowledge
      Architecture ref: §3 (escalation_rules/events), §4 (escalation attribute path, F23 zero-point), §5 catalog (escalation_rule.create/update/enable/disable — DEC-003; escalation.tick/acknowledge)
      Done when: escalation_rule.create/update (O, M, proposal_gated) and escalation_rule.enable (proposal_gated) / escalation_rule.disable (O, M, human_only, reason required) execute through the kernel with a steps before/after diff in audit (DEC-003); escalation.tick (Y, nat key exception+step) fires rule steps after due_at breach against active rules only — after_min measured from the breach, not raise (F23) — writing escalation_events, raising severity, queueing notifications; escalation.acknowledge records per event; rule matching by scope (workspace/client/site/commitment_type); disabling a rule does not retract already-fired escalation_events; tests green
      Depends on: SLICE-022

- [ ] SLICE-027: Outbound messages — email adapter + in-app + notify.send
      Architecture ref: §14, §3 (outbound_messages), §5 catalog (notify.send — confirmed Phase 2 scope, DEC-001), Appendix B (message.delivery_update)
      Done when: outbound_messages + Resend email adapter with catalog-keyed localized templates; notify.send autonomous_safe when sensitive=false, human_only (approved_by) when sensitive; in-app badges/toasts from reads; message.delivery_update kernel-internal op updates attempts/sent_at/status idempotently; escalation email lands in the test mail sink (phase done-means)
      Depends on: SLICE-026

- [ ] SLICE-028: Phase 2 lifecycle e2e
      Architecture ref: §19 Phase 2 done-means, F16
      Done when: simulated no-show walks open→owned→recovering→resolved→closed with escalation firing on a breached due_at; closure requires ≥1 recovery done; §20 1–8, 11, 12 green for the phase
      Depends on: SLICE-024, SLICE-025, SLICE-026, SLICE-027

## Phase 3: Reports, export, shares

- [ ] SLICE-029: report.generate — Leistungsnachweis snapshot + print view + inbox
      Architecture ref: §12, §5 catalog (report.generate, F26), §3 (reports), Appendix B (report.complete)
      Done when: report.generate (leistungsnachweis) builds an immutable Storage snapshot over closed windows only (F14) with frozen targets, verified records, proof index, exceptions summary, catalog version, and included window ids; branded print-CSS render; regeneration creates version n+1 and supersedes the prior; report.complete op flips generating→ready/failed; snapshot immutability + versioning tests green; manager report inbox ships
      Depends on: SLICE-017, SLICE-019

- [ ] SLICE-030: Window reopen lock on ready reports
      Architecture ref: §4 (closed→open reopen rule, F14), §12
      Done when: a ready leistungsnachweis or csv_export permanently locks its included windows against reopen (digests never lock); execution_windows.report_id points at the latest locking report; post-lock corrections happen via superseding records + report regeneration; lock test green
      Depends on: SLICE-017, SLICE-029

- [ ] SLICE-031: export.generate — CSV export contract v1
      Architecture ref: §12 (CSV contract, F26, F27), §5 catalog (export.generate), §2 (export boundary)
      Done when: export.generate (M, human_only) is the sole producer of csv_export report rows; row grain = window × person with person columns empty on output/service rows (F27); columns and order match the contract with contract_version=1 (§21.14); CSV parses into the spreadsheet fixture without manual edits (phase done-means); no pay/invoice calculation anywhere (§21.19)
      Depends on: SLICE-029, SLICE-030

- [ ] SLICE-032: Share links — create / revoke, public share page, view audit
      Architecture ref: §12 (share links), §5 catalog (report.share_create/revoke), §16 (rate limits), Appendix B (share.view), §20.10
      Done when: /s/{token} serves a read-only, session-free, rate-limited, noindex server-rendered page from the snapshot, metadata-first with no proof images (F34); 128-bit token stored hashed; optional PIN; expiry default 30 days; revoked/expired token → 404 live (§20.10); share.view op writes share.viewed audit events and bumps view_count/last_viewed_at (F7); tests green
      Depends on: SLICE-029

- [ ] SLICE-033: Web-push spike (optional per §19 Phase 3)
      Architecture ref: §14 (Phase 3 web push [FLEX]), §19 Phase 3
      Done when: web-push channel adapter behind outbound_messages delivers an escalation notification to a supervisor PWA, or the spike outcome is recorded and deferred — explicitly optional, does not gate the phase
      Depends on: SLICE-027

## Phase 4: Agents

- [ ] SLICE-034: Agent actor plumbing + AgentProposal machine + proposal.expire / supersede
      Architecture ref: §4 (AgentProposal), §5 (threshold classes, F2), §13, §20.9
      Done when: registered agent actors (agent_code) invoke actions through the kernel; the threshold gate converts proposal_gated agent invocations into AgentProposals with no mutation (F2); registry-wide test proves any agent invocation of any proposal_gated action creates a proposal and mutates nothing (§20.9); proposal.expire cron (nat key) and proposal.supersede work; tests green
      Depends on: SLICE-003

- [ ] SLICE-035: Proposal inbox + proposal.approve / reject
      Architecture ref: §4 (AgentProposal, F2, F18), §5 catalog, §21.16
      Done when: proposal.approve re-runs authorize + entitlement against the approving human and executes the underlying action in the same transaction attributed to that human, storing invocation_id, edited-input diff, and originating agent_code (F2, §21.16); approver authority checked against the underlying action — supervisors approve capture-scope proposals only (F18); reject requires reason; inbox UI ships (approve / edit-then-approve / reject per item); approve-with-edit test green
      Depends on: SLICE-034

- [ ] SLICE-036: Onboarding extractor — doc.upload + doc.extract_commitments
      Architecture ref: §13 (agent 1), §5 catalog (doc.*), F3, §19 Phase 4 done-means
      Done when: doc.upload stores documents with content hash; doc.extract_commitments (Anthropic API, server-side only, model + token counts in audit extras — §21.15) emits a batch of commitment.draft proposals with rationale, confidence, source spans; extraction is proposals-only — an agent never activates a commitment (F3); model routing config per agent task; golden-file test on two sample Einsatzvereinbarungen; a golden fixture document becomes reviewed→activated commitments producing next-day windows in the seed (phase done-means)
      Depends on: SLICE-013, SLICE-034, SLICE-035

- [ ] SLICE-037: Recovery preparer agent
      Architecture ref: §13 (agent 2), §5 catalog (recovery.propose)
      Done when: on exception.raise the agent drafts 2–3 concrete RecoveryActions via recovery.propose (autonomous_safe, output = drafts): replacement candidates from recent site assignees, client-notice draft, make-up window suggestion; approval and any external send remain human; tests green
      Depends on: SLICE-024, SLICE-034

- [ ] SLICE-038: Daily risk digest (system cron)
      Architecture ref: §13 (job 3, F1, F25), §12 (digests never lock, never in client inbox)
      Done when: morning system cron (actor_type=system) runs report.generate(type=digest, nat key workspace+date) over open exceptions, unstaffed windows, pending proofs, stale proposals, then notify.send(sensitive=false) referencing the snapshot (F25); digests lock no windows and skip the client report inbox; tests green
      Depends on: SLICE-027, SLICE-029, SLICE-034

- [ ] SLICE-039: Attribution + policy.demote_action (auto-demotion)
      Architecture ref: §13 (promotion path, F31), §5 catalog (policy.demote_action)
      Done when: an exception is attributable to a (workspace, action_name, agent) tuple when its refs/window trace to an entity last mutated by that tuple within 7 days; policy.demote_action (Y, autonomous_safe, nat key) fires on any severity≥3 exception.raise carrying that attribution, flipping the tuple back to proposal_gated; system only tightens, never promotes (F31); tests green; §20 1–12 green for the phase
      Depends on: SLICE-022, SLICE-034

## Phase 5: Entitlements + payer-2 readiness

- [ ] SLICE-040: Plans populated + entitlement gates enforced
      Architecture ref: §9, §5 (entitlement gate), §19 Phase 5, §21.18
      Done when: plans rows populated; gates sites.active, seats.manager (counting owner + manager, F23), feature.agents declared on actions and resolved centrally against plans.limits — domain code never reads plan names; creating a site or seat over limit blocks with a typed, catalog-translated reason (phase done-means, §21.18); limit-rejection tests green
      Depends on: SLICE-003 (replaces the Phase 0 noop-unlimited resolver)

- [ ] SLICE-041: Workspace-creation flow + onboarding checklist + smoke test
      Architecture ref: §19 Phase 5, §5 catalog (workspace.create)
      Done when: workspace-creation flow + onboarding checklist ship; the new-workspace smoke test provisions a second workspace end-to-end (phase done-means)
      Depends on: SLICE-005, SLICE-008, SLICE-040

- [ ] SLICE-042: Promotion path — stats read, plan.set, policy.promote_action, entitlement.override
      Architecture ref: §13 (promotion path), §5 catalog (policy.promote_action, plan.set / entitlement.override), §19 Phase 5 (plan.set confirmed in-phase, DEC-002)
      Done when: promotion-stats read computes per-(workspace, action, agent) trailing ≥50 proposals / ≥95% approved-without-edit / zero attributable sev≥3 from the audit log; policy.promote_action (O, human_only) flips proposal_gated→autonomous_safe for the eligible tuple only, storing the reliability-stats snapshot; human_only actions never promotable; plan.set (platform/O, human_only) updates a plan's limits/price with before/after in audit; entitlement.override executes with before/after limits in audit; tests green
      Depends on: SLICE-034, SLICE-039, SLICE-040

- [ ] SLICE-043: Hardening — rate limits, error/empty states, ops runbook
      Architecture ref: §19 Phase 5, §16 (application security)
      Done when: rate limits on /s/*, device.claim, PIN attempts verified; CSP + CRON_SECRET checks confirmed; error/empty states across surfaces; ops runbook written; full §20 1–12 green (phase closes v1)
      Depends on: SLICE-040, SLICE-041, SLICE-042 (final integration slice)

## Bootstrap ambiguities

- Appendix B kernel-internal ops have no phase assignment in ARCHITECTURE.md; they are slotted here with their owning feature (device.touch → SLICE-009, proof.upload_failed → SLICE-019, message.delivery_update → SLICE-027, share.view → SLICE-032, report.complete → SLICE-029) — confirm this mapping.
- The F19 Phase 4 action list names only proposal.*/policy.demote_action but its scope needs doc.upload and doc.extract_commitments (assumed in-phase, SLICE-036) — confirm the list is non-exhaustive. (Phase 2's equivalent gap — escalation.tick/acknowledge, notify.send — was resolved by DEC-001.)
- Phase 0 "Actions: that set" for workspace/person/client/site/device is read as the full catalog set for those entities, including person.pseudonymize and site.activate/archive (billing-meter actions before entitlements exist) — confirm.
- The window `open → missed` transition is part of the §4 window machine (Phase 1, SLICE-014 defines the machine) but its only trigger is the missed-window detector, which is Phase 2 scope; the transition is defined in Phase 1 and first exercised by SLICE-025 — confirm the split.
- The Phase 3 web-push spike is marked optional in §19; SLICE-033 is included but flagged non-gating — confirm whether it is in v1 scope at all.