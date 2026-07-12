# Phase 1 pre-implementation ambiguity sweep — SLICE-012 → SLICE-021

Prepared by Fable (architect/judge) against ARCHITECTURE.md v1.0 as amended through DEC-014, AGENTS.md, DECISIONS.md DEC-001–014 (incl. implementation-detail one-liners), PROGRESS.md incl. Bootstrap-ambiguities carried items. Method: each slice's scope and Done-when walked against §3, §4, §5 catalog rows, §8, §10, §11, §12, Appendix A/B, asking at every contract whether two reasonable implementers could build observably different systems. No [FIXED] ruling or resolved DEC is reopened; collisions are flagged and stopped at.

---

## 1. Findings table

| ID | Slice | Contract | Tier | One-line question |
|---|---|---|---|---|
| F-01 | 012 | commitment spec jsonb per type | **STOP** | What fields does each type's spec Zod schema contain — and where do a window's starts_at/ends_at times come from? |
| F-02 | 012 | verification / requirements / fulfillment jsonb | **STOP** | What are the stored shapes of `commitments.verification`, frozen `execution_windows.requirements`, and computed `fulfillment`? |
| F-03 | 012 | coverage fulfillment rule | **STOP** | How do concurrent `coverage_confirm` (headcount) and `presence` (per-person) records aggregate into one confirmed headcount? |
| F-04 | 012 | service_scope checklist + shortfall trigger | **STOP** | How is checklist completion represented in records/proofs, and which exception type does a service_scope shortfall raise? |
| F-05 | 012 | capture-UI hints format | impl | Are hints an exported surface or internal code? |
| F-06 | 013 | commitment.draft input | **STOP** | What is the exact exported input schema, incl. per-type required/forbidden fields and whether valid_to is required? |
| F-07 | 013 | commitment.update_spec | **STOP** | Which fields are updatable, patch or replace, and do draft and active commitments share one edit contract? |
| F-08 | 013 | rrule presets | impl | Which preset set do manager forms offer, and is free-text RRULE input allowed? |
| F-09 | 013 | auto-complete tick | impl | How does the Y auto-complete on valid_to run? |
| F-10 | 014 | windows of paused/completed commitments | **STOP** | What happens to already-generated `scheduled` windows when their commitment pauses or completes (no cancel path exists)? |
| F-11 | 014 | horizon + DST | impl | What exactly is "rolling 7-day horizon, timezone-correct"? |
| F-12 | 014 | early open bound | impl | May S/M open windows for future dates? |
| F-13 | 014A | seed replay no-op | impl | What does "re-running the seed is a no-op" mean under a rolling horizon? |
| F-14 | 015 | day-pack response schema | **STOP** | What is the exact day-pack shape — fields, persons scope, site status filter (draft item), manager scope, empty-day shape, ordering? |
| F-15 | 015 | catalog-label embedding | impl | Which label subset ships inside the day-pack? |
| F-16 | 016 | record.capture per-kind inputs | **STOP** | Which of qty/unit/started_at/ended_at/subject_person_id are required/forbidden per kind, and what happens on output unit mismatch? |
| F-17 | 016 | note content storage | **STOP** | Where does a `note` record's text live? No column exists for it anywhere in §3. |
| F-18 | 016/017 | late records vs window status | **STOP** | Are records accepted on fulfilled/shortfall/missed windows, and may recompute flip the status before reconcile? |
| F-19 | 016 | occurred_at bounds | impl | Is occurred_at validated against window bounds beyond the ±5 min skew rule? |
| F-20 | 016 | client_key semantics | impl | Does client_key need uniqueness beyond kernel idempotency? |
| F-21 | 016 | qty validation | impl | Numeric constraints per kind? |
| F-22 | 017 | window.close counts summary | **STOP** | What is the exported shape of the F20 advisory counts echo? |
| F-23 | 017 | reconcile timing + closed_at | impl | Nat key and 48-h zero-point for auto-reconcile; what does closed_at record? |
| F-24 | 017 | reopen stub + effects | impl | How is the F14 lock precondition stubbed, and what does reopen mutate? |
| F-25 | 018 | record.supersede correction | **STOP** | Which fields may a correcting record change relative to the superseded one? |
| F-26 | 018 | supersede/void reachability | impl | Guards for superseded/voided targets? |
| F-27 | 019 | proof.attach slot + content_hash | **STOP** | What is the upload-slot issuance shape, and is content_hash the pre-upload client hash or the post-re-encode stored hash? |
| F-28 | 019 | non-photo proofs + upload_failed | impl | Do checklist/note proofs skip the slot path; what triggers proof.upload_failed? |
| F-29 | 020 | assignment.set semantics | **STOP** | Set-vs-add on an existing/removed assignment, what fills `role`, and which persons are assignable (A1 boundary restated)? |
| F-30 | 021 | flush failure semantics | **STOP** | On flush: typed rejection vs error vs network failure — retry, park, or block, and what is the FIFO guarantee scope? |
| F-31 | 021 | outbox identity partitioning | **STOP** | Whose session may flush a queued item when refresh fails or a different person signs in (DEC-013 item 11 edge)? |
| F-32 | 021 | batch confirm | impl | Batch confirm has no catalog action — resolve against §5 exact-match. |
| F-33 | 021 | queue cap | impl | Is there an outbox size limit? |
| F-34 | 021/015 | service-worker scope | impl | What precisely must the SW cache for §21.12 under DEC-013's browser-first ruling? |

14 STOP-tier, 20 implementation-detail.

---

## 2. STOP-tier findings in full (DEC-009 option format, ordered by first-hitting slice)

### F-01 — Per-type spec schema; source of window times (SLICE-012; §3 F10, §5 commitment.draft, §19 P1)

**Question:** §3 fixes title/schedule_rrule/target_qty/unit/verification/valid_from/valid_to as columns and leaves `spec jsonb` "validated by type def" — what does each type's spec contain, and specifically where do a generated window's `starts_at`/`ends_at` come from, since an RRULE alone yields dates and nothing in §3/§5 defines a time-of-day source?

- **(A)** Spec carries the window template: `{window_start_time, window_end_time}` as local wall-clock strings (workspace tz), plus per-type extras only — coverage: none further; output: none further (qty/unit are columns); service_scope: `{checklist: [{key, label}]}`. RRULE governs dates only. A reviewer picks this because wall-clock times survive DST correctly (converted per occurrence date at generation) and the fixed columns stay the single home for cross-type fields.
- **(B)** Encode times in the RRULE via DTSTART/BYHOUR and derive duration from spec. A reviewer picks this to keep spec near-empty, accepting that DTSTART-anchored UTC times drift one hour across DST for a frontline product whose windows are wall-clock shifts, and that agents must parse RRULE internals.
- **(C)** Times per type definition (code constant). A reviewer picks this for the smallest input, accepting that all commitments of a type share one shift time — unusable for the pilot.

**Recommendation: A.** Reversibility: spec is jsonb — adding fields later is free; wrong wall-clock semantics baked into frozen windows on a billing trail are permanent. Blast radius: this shape flows into the exported JSON Schema (public API), frozen requirements, and every generated window — get it right once, before the first `commitment.draft` exists. One window per commitment per local date is implied by the fixed nat key `window.generate:{commitment_id}:{date}` ([FIXED] §5) — a multi-shift day is two commitments; flagged, not reopened.

### F-02 — verification / requirements / fulfillment jsonb formats (SLICE-012/014/016; §3, A3, F10)

**Question:** Three stored jsonb formats are undefined: `commitments.verification` (per-commitment proof demands), `execution_windows.requirements` (frozen at generation, A3), and `execution_windows.fulfillment` (computed, feeds reports/CSV).

- **(A)** Minimal canonical shapes: `verification = {proof: {required: bool, types: ('photo'|'signature')[], min_count}}`; `requirements` = frozen copy `{verification, checklist?}` (checklist copied from spec for service_scope) — derived solely from the commitment at generation; `fulfillment = {rule, target_qty, unit, verified_qty | confirmed_headcount | checklist_state, satisfied: bool, counted_record_ids, computed_at}`. A reviewer picks this because each consumer (close, detectors, snapshot, CSV verified_qty) reads a typed shape and the freeze test (§20.11) has a concrete object to compare.
- **(B)** Opaque per-type shapes owned by each type definition, validated but not architecturally fixed. A reviewer picks this for flexibility, accepting that Phase 3 snapshots and the CSV contract then depend on three private formats that drift per type.
- **(C)** Store scalars in relational columns instead and leave the jsonbs empty. Collides with §3's fixed rows — a schema change with no benefit.

**Recommendation: A.** Reversibility: additive keys are cheap; a format churn after Phase 3 snapshots embed these objects means report re-versioning. Blast radius: `fulfillment` is the number the Leistungsnachweis bills against — a stored-data format squarely on the STOP list.

### F-03 — Coverage aggregation across record kinds (SLICE-012/016; §3 F10, §11)

**Question:** F10 allows coverage windows to be satisfied by `coverage_confirm` (headcount) "and/or" `presence` (per-person) — with §11 guaranteeing concurrent supervisors both append — so how do multiple records of both kinds aggregate into one confirmed headcount without double-counting?

- **(A)** `confirmed_headcount = max(max qty over verified coverage_confirm records, count of distinct subject_person_id over verified presence records)`. A reviewer picks this because append-only concurrent capture can never inflate the count (two supervisors confirming "all 5 present" yields 5, not 10) and mixed capture styles coexist.
- **(B)** Sum all records. A reviewer picks this only for arithmetic simplicity; it double-counts by construction under §11's two-supervisor scenario — billing-adjacent inflation.
- **(C)** Latest verified record wins, by occurred_at. A reviewer picks this for "most recent truth", accepting that a late-syncing offline record with an earlier occurred_at silently changes history ordering and that mixing kinds is undefined.

**Recommendation: A.** Reversibility: fulfillment is a pure recompute over facts — changing the function later re-derives everything; no stored damage. Blast radius: the aggregate is what fulfilled/shortfall and the pilot's invoice-supporting numbers hang on, so the safest-under-concurrency rule wins.

### F-04 — service_scope checklist capture + shortfall exception type (SLICE-012; §3 F10, §4 detector table)

**Question:** F10 says service_scope is "fulfilled when the frozen requirements checklist is complete", but no record or proof field is designated to carry per-item completion, and §4's detector table maps only coverage→under_coverage and output→output_shortfall — leaving both the capture representation and the shortfall exception type for service_scope undefined.

- **(A)** One `service_confirmation` record carries a checklist-type proof whose `proofs.checklist jsonb` stores `{items: [{key, done, note?}]}` against the frozen requirement keys; fulfillment = every required key done on the latest verified record's proof; shortfall on close raises exception type `output_shortfall` (an incomplete deliverable checklist is an output shortfall in category terms). A reviewer picks this because §3 already reserves `proofs.checklist jsonb` for exactly this and no schema change is needed.
- **(B)** One `service_confirmation` record per checklist item (item key in a new column/spec ref); fulfillment counts distinct confirmed items. A reviewer picks this for per-item audit granularity, accepting a schema addition and a noisier record stream.
- **(C)** As (A) but raise exception type `other`. A reviewer picks this to avoid stretching `output_shortfall`, accepting that `other` carries no detector semantics and weakens Phase 2 reporting.

**Recommendation: A.** Reversibility: (A) uses only reserved fields — switching to (B) later is additive; blast radius: the exception type is visible in dashboards/reports but corrigible in Phase 2 if the pilot's vocabulary disagrees, whereas a schema detour now is the costlier error.

### F-06 — commitment.draft input contract (SLICE-013; §5 catalog, §3, DEC-008/009 precedent)

**Question:** §5 gives "type, site, spec, schedule" — what is the exact exported input schema, including per-type required/forbidden fields and whether `valid_to` is required (§3 carries no `?` on valid_from/valid_to, so SLICE-002's marker rule made both NOT NULL — silently forbidding open-ended commitments)?

- **(A)** Flat 1:1 per DEC-008/009 precedent: `site_id` (client_id derived; must reference an active site — draft/archived rejected), `type`, `title` (1–200), `spec` (per-type Zod, F-01), `schedule_rrule` (must parse; presets per F-08), `verification?` (defaulted per type), `valid_from` (date, required), `valid_to` (date, required, ≥ valid_from), `target_qty`/`unit` per type: coverage → target_qty required integer ≥1, unit forbidden; output → target_qty required >0 and unit required; service_scope → both forbidden. A reviewer picks this to keep the NOT NULL schema and DEC-008's flat/patch discipline intact — every commitment has an explicit end and auto-completes.
- **(B)** As (A) but valid_to nullable (open-ended) via a CHANGE-REQUEST migration. A reviewer picks this because real Dauereinsätze are open-ended and forcing fake end dates trains users to set far-future values that defeat auto-complete anyway.
- **(C)** Nested `{spec: {...everything}}` input. Collides with DEC-008 R2's flat-fields ruling — flagged, rejected.

**Recommendation: A** for Phase 1. Reversibility is the whole argument: widening NOT NULL → nullable later is one trivial migration when the pilot demands it, while (B) now spends a post-Phase-0 schema CHANGE-REQUEST on an unproven need; blast radius of (A) is a pilot workaround (set valid_to a year out), of a wrong (B) nothing — but the burden of proof sits with changing the schema, and no pilot evidence exists yet.

### F-07 — commitment.update_spec edit contract (SLICE-013; §4, §5, A3)

**Question:** §5 gives input "diff" and §4 says spec edits are "free while draft" — does update_spec cover only `spec` or the full definition (title, schedule_rrule, target_qty, unit, verification, valid_from/to), with patch or replace semantics, and does one contract serve both draft and active states?

- **(A)** One action, patch semantics (DEC-008 R4 precedent): input `commitment_id` plus any of title, spec, schedule_rrule, target_qty, unit, verification, valid_from (draft only), valid_to; `type` and `site_id` immutable forever; identical contract on draft and active, with A3 confining active-state effect to windows generated after the edit; empty patch rejected. A reviewer picks this because no other edit action exists in the catalog and per-field patches produce the minimal before/after audit diffs §5 mandates.
- **(B)** update_spec touches literally only `spec`; other fields are immutable after draft creation (delete-and-redraft to fix a title). A reviewer picks the narrowest reading of the action name, accepting that a typo in a title becomes an archive-and-recreate ceremony.
- **(C)** Full-replacement semantics. Collides with DEC-008's established patch precedent for this exact question class — flagged, rejected.

**Recommendation: A.** Reversibility: restricting fields later is a tightening (always allowed); blast radius: the exported schema and the A3 freeze boundary — (A) keeps one legible contract whose per-type validation (F-06) re-runs on every patch, so a patched active commitment can never become invalid for future generation.

### F-10 — Scheduled windows of paused/completed commitments (SLICE-014; §4)

**Question:** When a commitment pauses or completes, its already-generated `scheduled` windows have no exit path — §4's machine has no cancelled state and `scheduled` transitions only to `open` — so do those windows run to `missed` (auto-raising Phase 2 exceptions for deliberately paused work)?

- **(A)** Generation gates on `status='active'` at generate time; already-generated scheduled windows remain and run their course (open/close or miss); no machine change in Phase 1. A reviewer picks this because it adds zero transitions to a machine that freezes at Phase 1 review, and the pilot's exposure is bounded to ≤7 days of horizon per pause.
- **(B)** Add a `cancelled` window status plus `scheduled → cancelled` fired inside pause/complete. A reviewer picks this for semantic honesty, accepting a schema enum addition, a new §4 transition, and a new "cancelled windows excluded from" rule in day-pack, detectors, archive's open-window predicate, and reports — a wide static blast radius for a rare event.
- **(C)** Hard-delete scheduled windows on pause. Collides with §3's "nothing hard-deletes" convention — flagged, rejected.

**Recommendation: A.** Reversibility: (A) leaves (B) fully open as a Phase 2 decision informed by real detector noise; (B) now is a one-way enum + machine widening bought on speculation. Blast radius: (A)'s cost is transient exception noise arriving only when Phase 2 detectors exist — by which point the operator will know whether pausing is even used at the pilot. Note in DEC-016 that Phase 2's "exactly one open exception per shortfall/missed window" done-means will surface this deliberately.

### F-14 — Day-pack read response schema (SLICE-015; §11 F29, §10, §8 F12, DEC-009 carried item)

**Question:** The day-pack becomes cached offline state and an exported public read surface (F29), yet its exact shape is undefined — fields per window, which persons ship, which site statuses appear (colliding with DEC-009's carried-forward draft-site visibility item), what a manager's pack scopes to, the empty-day shape, and ordering.

- **(A)** Canonical shape: `{date, generated_at, sites: [{site_id, name, windows: [{window_id, commitment_id, title, type, starts_at, ends_at, target_qty, unit, requirements, fulfillment, status, assignments: [{person_id, display_name, status}]}]}], persons: [{person_id, display_name, role_class}] (exactly those referenced by assignments), labels: {capture-namespace catalog, person's locale}}`; sites = `status='active'` only, in the caller's F12 scope (managers per F6: all active sites), name-ascending; windows = the requested local date, starts_at-ascending; a scoped site with zero windows still appears with `windows: []`; zero scoped sites returns `sites: []`, never an error. A reviewer picks this because it is the minimal set §11 names (windows, assignments, persons, catalog labels) with PII held to display_name and the offline capture UI fully renderable from cache.
- **(B)** Include all active workspace persons (so offline presence capture can pick anyone). A reviewer picks this for capture flexibility, accepting a workspace-wide PII roster cached on every supervisor device — a data-minimization step backwards §16 doesn't support.
- **(C)** Include draft sites (manager view). Collides with DEC-009's carried-forward instruction that nothing be built against draft visibility until resolved — flagged; DEC-016 resolves only the narrow point that day-packs contain active sites, which stays valid under any future draft ruling.

**Recommendation: A.** Reversibility: F29 makes additive read-field growth a PR-DEVIATIONS matter, so starting minimal costs nothing; removing an over-shared field from a cached offline surface later is effectively impossible (devices hold it). Blast radius: this is the single largest cached-PII and public-read decision in Phase 1 — least exposure wins. Presence capture accepts any valid in-workspace active person_id even if absent from the pack (facts over plans, A1); the UI offers assigned persons first.

### F-16 — record.capture per-kind input matrix + unit rule (SLICE-016; §5, §3, F10)

**Question:** §5 gives "window_id, kind, qty/times, client_key" — which fields are required/forbidden per kind, and is an output record whose unit differs from the window's frozen unit rejected, excluded, or counted?

- **(A)** Matrix: common = window_id, kind, occurred_at, client_key. presence → subject_person_id required (active, in-workspace), started_at/ended_at optional, qty/unit forbidden. coverage_confirm → qty required (integer ≥ 0), unit/subject/times forbidden. output → qty required (> 0) and unit required and it must equal the window's frozen unit, else typed rejection `unit_mismatch`; subject optional. service_confirmation → qty/unit forbidden; checklist rides the attached proof (F-04). note → text per F-17, all quantitative fields forbidden. A reviewer picks this because forbidden-field strictness keeps the exported schema honest and the unit rejection prevents silently un-aggregatable facts on a billing trail.
- **(B)** All fields optional everywhere; fulfillment ignores what it can't use, mismatched units excluded with a warning. A reviewer picks this for offline leniency (never reject a queued fact), accepting permanently stored records that look verified but count for nothing — the least legible outcome for a Leistungsnachweis.
- **(C)** As (A) but unit omitted from output input entirely (server stamps the frozen unit). A reviewer picks this for one less field, accepting that a client capturing in the wrong unit is silently relabeled rather than caught.

**Recommendation: A.** Reversibility: loosening a required/forbidden rule later is additive schema evolution; un-rejecting stored mismatched facts is not. Blast radius: rejection at capture surfaces in the outbox failure path (F-30) exactly once with a clear code — the honest place — instead of surfacing at invoice time.

### F-17 — note record content storage (SLICE-016; §3 — genuine schema gap)

**Question:** The `note` record kind exists (F10: cross-cutting, never satisfies fulfillment) but no column in `execution_records`, and no text field in `proofs`, can hold a note's text — where does it live?

- **(A)** CHANGE-REQUEST-authorized migration adding `execution_records.note text?` (nullable, a fact column under the F4 immutability trigger), required for kind=note (1–2000), optional annotation on other kinds forbidden in v1 (kind=note only). A reviewer picks this because a note is a first-class immutable fact and this is the only shape that stores it as one.
- **(B)** Smuggle text into `proofs.checklist jsonb` on a proof of type note. A reviewer picks this to avoid a migration, accepting a stored-data format that lies about its own name — an agent-illegibility tax forever.
- **(C)** Drop the note kind from Phase 1 capture. A reviewer picks this to defer the question, but §19 Phase 1 scope lists note capture explicitly — a scope cut only the operator can make.

**Recommendation: A.** Reversibility: an additive nullable column is the cheapest migration class; §19's post-Phase-0 schema rule routes it through CHANGE-REQUEST, which this omnibus DEC satisfies. Blast radius: one column, one trigger-set update, one Zod field.

### F-18 — Late records vs window status before reconcile (SLICE-016/017; §4, §11)

**Question:** §11 guarantees offline captures may flush after a manager has closed the window, and §4 says fulfillment recomputes on every record event — so is record.capture accepted on fulfilled/shortfall/missed (pre-reconcile) windows, and may the recompute flip fulfilled↔shortfall, a transition the §4 machine doesn't list?

- **(A)** Capture (and supersede/void recompute) is accepted on any window not in `closed`; recompute may move fulfilled↔shortfall (and missed→fulfilled/shortfall when late verified records arrive), added to the §4 machine as system-triggered recompute transitions before the Phase 1 freeze; `closed` windows reject capture with a typed code (corrections post-reconcile = reopen or supersede path per F14). A reviewer picks this because offline facts are never dropped and the status label never contradicts the fulfillment jsonb on a billing trail.
- **(B)** Accept the records, recompute the jsonb, freeze the status until reconcile re-derives it. A reviewer picks this to avoid touching the machine, accepting a window that displays "fulfilled" while its own fulfillment object says shortfall — and requiring reconcile to become a computing action rather than a pure lock.
- **(C)** Reject capture on any post-open status. A reviewer picks this for machine purity, accepting systematic loss of legitimately captured offline facts — the exact failure §11's [FIXED] protocol exists to prevent; effectively collides with §11.

**Recommendation: A.** The window machine ships and freezes in this phase, so defining these transitions now is the legal moment; reversibility of (A) is high (transitions are tightening-removable pre-freeze, and recompute is a pure function), while (B)'s stale-status inconsistency and (C)'s fact loss are both trust-destroying at the pilot. Blast radius: visible state behavior — precisely why it needs the operator's signature, not an agent's guess.

### F-22 — window.close counts-summary shape (SLICE-017; §5, F20)

**Question:** F20 [FIXED] makes the client counts summary advisory-only — not reopened — but its exported input shape is undefined.

- **(A)** Optional discriminated object mirroring the type's aggregate: `counts?: {headcount: int} | {total_qty: number, unit: string} | {checked_items: int}`; server compares to its computed fulfillment and appends warning `counts_mismatch` with both values; absence = no comparison. A reviewer picks this because the exported schema stays typed and the F20 warning has concrete operands.
- **(B)** Opaque `counts?: jsonb` echoed into audit extras verbatim. A reviewer picks this for zero coupling to type definitions, accepting an untyped hole in the public API/MCP surface.
- **(C)** Omit the field. Collides with the §5 catalog row, which names it — flagged, rejected.

**Recommendation: A.** Reversibility: an optional input field can widen freely; blast radius is one warning code — small, but it is public API surface, hence STOP by rule rather than by risk.

### F-25 — record.supersede correction contract (SLICE-018; §4, §5)

**Question:** §5 gives "record_id, correction" — which fields may the correcting record change relative to the superseded one?

- **(A)** Correction = the record.capture field set for the inherited kind, minus window_id and kind (both copied from the target, immutable), with a fresh client_key; the new record enters `verified` auto-verified (F32), old → `superseded`, `supersedes_id` links; only `verified` targets accepted. A reviewer picks this because a correction that can silently move a fact to another window or change its kind isn't a correction, it's a deletion plus re-creation wearing a link.
- **(B)** Full re-capture shape including window_id/kind. A reviewer picks this for maximal fixing power, accepting that the supersede chain then no longer proves "same fact, better numbers" — weakening exactly what makes records billing-grade (§6).
- **(C)** Only qty/unit/times correctable, subject_person_id immutable. A reviewer picks this as strictest, accepting that a wrong-person presence tap — the most common capture error — becomes uncorrectable except by void + new capture (two human_only/M-gated steps for a supervisor-fixable mistake).

**Recommendation: A.** Reversibility: tightening toward (C) later is allowed by construction; blast radius: the supersede chain is the §6 correction primitive the whole audit story cites — same-window/same-kind is the invariant that keeps it legible.

### F-27 — proof.attach slot contract + content_hash timing (SLICE-019; §5, §11, §16 F34)

**Question:** proof.attach's result "→ upload slot" and its `content hash` audit extra are undefined in shape and timing — is content_hash the client's pre-upload hash of the captured blob, or the hash of the post-re-encode stored object (F34 strip changes the bytes, so they necessarily differ)?

- **(A)** Input `{record_id, type, content_hash (client sha256 of the original blob), byte_size}`; result `{proof_id, upload: {url, method, headers, expires_at}}` (Supabase signed upload URL under the ws/{workspace_id}/ path module); `proofs.content_hash` stores the original-capture hash permanently (it attests what was captured); proof.complete_upload verifies the uploaded object against it, then re-encodes/strips (F34) and records the stored object's hash in audit extras alongside. A reviewer picks this because integrity attaches to the fact at capture time — which is what the proof exists to prove — while the stored-object hash remains auditable.
- **(B)** content_hash = post-strip stored hash, computed server-side at complete_upload; attach carries no hash. A reviewer picks this for storage-integrity simplicity, accepting that nothing ever attests the original bytes and the catalog's attach-time "content hash" audit extra becomes unfillable.
- **(C)** Store both as columns. Requires a schema addition for a value audit extras already carries — weakest cost/benefit.

**Recommendation: A.** Reversibility: audit extras can gain the second hash at any time; blast radius: content_hash semantics on immutable rows can never be reinterpreted later — the capture-time meaning must be fixed before the first proof row exists.

### F-29 — assignment.set semantics + role + assignable persons (SLICE-020; §3, §5, §8 A1)

**Question:** With input only `{window_id, person_id}`, is set an upsert (reviving a `removed` assignment), what fills the `role text` column, and which persons are valid targets — restating A1: assignments drive board content and no-show detection only, never authorization?

- **(A)** Unique (window_id, person_id); set = idempotent upsert to `planned` (removed → planned revival, no duplicate rows); remove = status `removed`; role is not an input in v1 — the column stores the person's role_class snapshot at set time; targets = any active in-workspace person of any role_class (supervisors assign themselves for presence); `confirmed` stays unreachable per F22. A1 restated verbatim in the slice contract. A reviewer picks this because upsert is the only idempotency-coherent reading of "set" and role-as-snapshot fills a NOT NULL column without widening the exported input.
- **(B)** set on an existing assignment is a typed rejection (strict add). A reviewer picks this for explicitness, accepting that offline retry ergonomics degrade (a replayed set after a remove becomes an error) for no capability difference.
- **(C)** role becomes a public input. A reviewer picks this for future flexibility, accepting an exported-API widening with no v1 consumer — AGENTS.md's scope rule argues directly against it.

**Recommendation: A.** Reversibility: all three converge on the same rows; (A) is the least-surface, most-idempotent reading. Blast radius: small, but the input schema is exported — STOP by rule.

### F-30 — Outbox flush failure semantics + FIFO scope (SLICE-021; §11, §20.8)

**Question:** §11 fixes FIFO flush but not what happens when one queued invocation returns a typed rejection, a status=error, or a network failure — retry, park, or surface — and whether one bad item blocks everything behind it.

- **(A)** Ordering = per-device FIFO dispatch; network failure → item stays at head, retry with backoff (nothing lost); status=error (500) → bounded retries (replay-safe by idempotency), then park; typed rejection → deterministic, never auto-retried: item moves to a visible "failed" list (badge + per-item reason from the catalog-translated code) and flushing continues with the next item; parked items are manually discardable, never silently dropped. A reviewer picks this because rejections are deterministic (retrying is pointless) and head-of-line blocking would hold hostage every fact captured after one poison item.
- **(B)** Strict head-of-line blocking: any failure halts the queue until resolved. A reviewer picks this for absolute ordering, accepting that one rejected item silently stops all sync — the supervisor keeps capturing into a queue that will never drain.
- **(C)** Auto-retry everything forever. A reviewer picks this for zero UI, accepting infinite retries of deterministic rejections and a queue that grows unbounded.

**Recommendation: A.** Reversibility: park-and-continue can be tightened to blocking later with no data model change; blast radius: this decides whether captured facts survive edge cases at the pilot — §11's whole promise. Cross-window ordering matters only within one window's record stream, and record facts are order-independent by construction (append-only, recompute) — per-device FIFO dispatch with continue-on-park preserves every guarantee §11 actually states.

### F-31 — Outbox identity partitioning (SLICE-021; §11, DEC-013 item 11)

**Question:** DEC-013 item 11 requires session refresh + membership validation before flushing, but not what happens to queued items when refresh fails or a different person signs in on the same browser — whose session may flush whose facts?

- **(A)** The outbox is partitioned by (auth_user_id, workspace_id); only a live session matching both may flush a partition; on refresh failure items stay queued behind an offline/relogin banner and flush after the same identity re-authenticates; another identity's partitions are inert (invisible to flush, purgeable only via explicit UI). A reviewer picks this because captured_by attribution is derived from the flushing session — cross-identity flush would misattribute billing-grade facts.
- **(B)** One shared queue flushed by whichever valid session appears next. A reviewer picks this so shared devices never strand data, accepting that person B's session attributes person A's captures to B on an immutable trail — the harm is permanent by design (§6).
- **(C)** Purge the queue on any session-identity change. A reviewer picks this for privacy hygiene, accepting silent destruction of captured facts — worse than misattribution.

**Recommendation: A.** Reversibility: partition keys can be relaxed later; misattributed or destroyed immutable facts cannot be fixed. Blast radius: attribution on the audit trail — SECURITY/AUTHZ-adjacent and permanent, the clearest STOP in the set.

---

## 3. Implementation-detail findings — smallest-safe rule per item

- **F-05 (012) capture-UI hints:** internal TypeScript structure in the type definition, consumed by the capture UI at build time; never serialized into reads, stored data, or the JSON Schema export. If a future read embeds them, that is a new STOP.
- **F-08 (013) rrule presets:** presets only, no free-text RRULE editor (least capability): daily; Mo–Fr; weekly on selected weekdays; every 2 weeks on selected weekdays. Stored value is the standard RRULE string; the preset list is UI vocabulary, extendable per workspace later without contract change.
- **F-09 (013) auto-complete:** daily cron scans active/paused commitments with valid_to < today (workspace tz), invoking commitment.complete with the catalog nat key `commitment.complete:{commitment_id}`; idempotent by construction.
- **F-11 (014) horizon/DST:** horizon = local dates [today, today+6] in the workspace tz; occurrence dates from the RRULE evaluated in that tz; starts_at/ends_at = spec wall-clock times converted per occurrence date (DST-correct because conversion is per-date); an end time ≤ start time means the window ends next day.
- **F-12 (014) early open:** S/M early open permitted only for windows whose `date` = today in the workspace tz; otherwise typed rejection. Least capability under the unconditioned catalog grant.
- **F-13 (014A) seed replay:** "no-op" = deterministic keys make re-runs duplicate-free; a later run may generate windows for newly-in-horizon dates. Fixture commitments use fixed ids/keys; window keys are the catalog nat key.
- **F-15 (015) label subset:** the capture-surface namespace of the catalog in the person's locale (fallback de), embedded as a flat key→string map; nothing outside that namespace ships in the pack.
- **F-19 (016) occurred_at:** no window-bounds validation; only the [FIXED] ±5 min occurred_at/received_at skew rule applies (flag in audit extras, surface in reconcile view). Adding a bounds rule would reject legitimate late/early facts.
- **F-20 (016) client_key:** provenance column only; uniqueness is already guaranteed by the (workspace_id, idempotency_key) contract since client_key = the idempotency key; no second unique index.
- **F-21 (016) qty validation:** qty ≥ 0 everywhere it's allowed; integer for coverage_confirm; > 0 for output; numeric(12,3) precision cap at the Zod layer (no schema change).
- **F-23 (017) reconcile timing:** nat key `window.reconcile:{window_id}` (one lock per window); `closed_at` is written when the window enters any of fulfilled/shortfall/missed (`closed_by` = the closing actor, NULL for the missed transition); the 48 h auto-reconcile zero-point is that `closed_at`; the reconcile moment itself lives in the reconcile audit event.
- **F-24 (017) reopen stub/effects:** the F14 lock predicate is implemented for real as `report_id IS NULL` (vacuously true until Phase 3 — no literal stub to remove later); reopen mutates status only (closed → open); fulfillment stands and recomputes on subsequent record events; closed_at/closed_by are overwritten by the next close.
- **F-26 (018) reachability guards:** supersede accepts only `verified` targets; void accepts only `recorded`/`verified` (per the §4 machine — superseded rows are terminal for both); typed rejections otherwise; a correcting record is itself supersedable (chains allowed, each link explicit).
- **F-28 (019) non-photo proofs / upload_failed:** photo and signature proofs use the slot path (pending_upload → complete); checklist proofs carry `checklist jsonb` inline at attach and are `complete` immediately (no slot, no content_hash requirement); proof type `note` stays registered-unused in v1 (note text lives on the record per F-17). proof.upload_failed fires from a system sweep over pending_upload proofs whose slot `expires_at` has passed; client retry = a fresh proof.attach (new slot), the failed row stays as history.
- **F-32 (021) batch confirm:** resolved against §5 exact-match — no batch action exists and none is added; batch confirm is client-side fan-out, one record.capture per window with its own client_key, partial failure surfaced per window through the F-30 semantics. Adding a server batch action would be a catalog change requiring its own DEC.
- **F-33 (021) queue cap:** no hard cap (refusing capture offline = data loss); warning banner at ≥100 queued items; IndexedDB quota is the physical bound and quota errors surface as capture-time errors, never silent drops.
- **F-34 (021/015) service-worker scope:** SW pre-caches the (capture) app shell (routes, JS/CSS, manifest, icons, catalog chunk) so the board renders offline from the IndexedDB-cached day-pack; the SW never caches (dashboard) routes, /api/actions, or any authenticated API response — the day-pack is cached by app code in IndexedDB, not by SW fetch interception; Background Sync registration is progressive enhancement, with focus/online-event flush as the guaranteed path. Satisfies §21.12 (manifest, SW, outbox, day-pack) under DEC-013 item 13.

---

## 4. Draft omnibus DEC-016 (ready for operator approval)

### DEC-016 — 2026-07-12 — Phase 1 omnibus: capture/commitment/window/day-pack/outbox contracts (SLICE-012 → SLICE-021)
- Status: OPEN
- Raised by: Phase 1 pre-implementation ambiguity sweep (Fable, architect/judge), commissioned by the operator to replace reactive per-slice stops. No Phase 1 code written.
- Question: Fourteen STOP-tier contracts across SLICE-012–021 are underspecified in §3/§4/§5/§8/§10/§11 such that two reasonable implementers would build observably different systems — action input schemas (exported public API per §5), stored jsonb formats, state-machine edge transitions, cached-read surfaces, and offline flush behavior. Full options and consequences per item in the sweep document (findings F-01…F-31); this entry records the question set and the recommended resolutions for single-pass approval.
- Options considered: per finding, 2–3 options each with the consequence that would make a reviewer pick it — see sweep §2 (incorporated by reference; the option lettering below matches it).
- Recommended resolutions (each independently approvable; an unapproved item re-blocks only its own slices):
  1. **F-01 → A.** spec jsonb carries `{window_start_time, window_end_time}` (local wall-clock, workspace tz) plus per-type extras (service_scope: checklist items); RRULE governs dates only; one window per commitment per local date stands per the [FIXED] §5 nat key.
  2. **F-02 → A.** Canonical shapes fixed for verification (proof demands), requirements (frozen copy of verification + checklist, derived solely from the commitment at generation), and fulfillment (`{rule, target_qty, unit, aggregate, satisfied, counted_record_ids, computed_at}`).
  3. **F-03 → A.** Coverage headcount = max(max coverage_confirm qty, distinct presence persons) over verified records — concurrency-safe, never double-counts.
  4. **F-04 → A.** service_scope completion = checklist-type proof (`proofs.checklist jsonb`, per-item done flags against frozen keys) on a service_confirmation record; service_scope shortfall raises exception type `output_shortfall`.
  5. **F-06 → A.** commitment.draft = flat 1:1 fields (DEC-008/009 precedent) with the per-type required/forbidden matrix as specified; valid_from and valid_to remain required (schema unchanged); open-ended commitments deferred to a future widening DEC on pilot evidence.
  6. **F-07 → A.** commitment.update_spec = patch over {title, spec, schedule_rrule, target_qty, unit, verification, valid_from (draft only), valid_to}; type and site_id immutable; one contract for draft and active; A3 governs active effect.
  7. **F-10 → A.** window.generate gates on active commitments; already-generated scheduled windows of paused/completed commitments remain and run their course; no cancelled state in Phase 1; revisit on Phase 2 detector-noise evidence.
  8. **F-14 → A.** Day-pack schema fixed as specified: active sites in the caller's F12 scope (managers: all active sites, F6), assigned-persons-only roster (display_name + role_class), capture-namespace labels, empty-day shapes, name/starts_at ordering. Partially resolves DEC-009's carried draft-site item in the narrowest way (day-packs contain active sites only); all other draft-lifecycle questions remain the carried open item.
  9. **F-16 → A.** record.capture per-kind required/forbidden matrix as specified; output unit must equal the window's frozen unit (typed rejection `unit_mismatch`).
  10. **F-17 → A.** Authorizes one post-Phase-0 migration (per §19's CHANGE-REQUEST route): additive nullable fact column `execution_records.note text` under the F4 trigger set; required (1–2000) for kind=note, forbidden otherwise.
  11. **F-18 → A.** record events accepted on any window not in `closed`; recompute may transition fulfilled↔shortfall and missed→fulfilled/shortfall as system-triggered transitions added to the §4 window machine before its Phase 1 freeze; `closed` rejects capture with a typed code.
  12. **F-22 → A.** window.close `counts?` = typed discriminated object per type aggregate; mismatch → warning `counts_mismatch` per F20 (F20's advisory ruling untouched).
  13. **F-25 → A.** Supersede correction = capture field set minus window_id/kind (inherited, immutable), fresh client_key, verified-only targets.
  14. **F-27 → A.** proof.attach carries client-computed content_hash of the original blob (stored permanently as proofs.content_hash); result = `{proof_id, upload: {url, method, headers, expires_at}}`; complete_upload verifies, then re-encodes/strips (F34) and records the stored-object hash in audit extras.
  15. **F-29 → A.** assignment.set = idempotent upsert to planned (removed→planned revival), unique (window_id, person_id); role column = role_class snapshot, not an input; targets = active in-workspace persons; A1 (assignments never authorize) restated in the slice contract.
  16. **F-30 → A.** Flush: per-device FIFO dispatch; network failure retries in place; error status retries bounded then parks; typed rejections park to a visible failed list (catalog-translated reason) and flushing continues; parked items discardable only by explicit user action.
  17. **F-31 → A.** Outbox partitioned by (auth_user_id, workspace_id); only a matching live session flushes a partition; refresh failure leaves items queued behind a re-login banner; other identities' partitions are inert and never auto-flushed or auto-purged.
  18. The 20 implementation-detail findings (sweep §3) are confirmed as smallest-safe rules; implementing agents apply them without re-derivation and log them as DECISIONS.md one-liners per AGENTS.md AMBIGUITY.
- Why this needs human sign-off: items 1–2, 4–6, 9–10, 12–15 fix stored data formats and the exported public API/MCP surface; items 3, 11 fix fulfillment computation and state-machine transitions on the billing-grade trail; item 8 fixes a cached who-can-see-what read surface; items 16–17 fix visible offline behavior and audit attribution. PRODUCT, DOMAIN, ACTION kernel, AUDIT, PRIVACY/PII, and SECURITY/AUTHZ categories from the AGENTS.md STOP list are all touched; none qualifies as an implementation detail.
- Resolution: *(unfilled — operator approval required; an agent may transcribe the operator's answer verbatim, naming the approver)*
- Architecture impact (if approved as recommended): amends §3 (execution_records gains `note text?` — migration rides the SLICE-016 implementation PR; jsonb shapes for commitments.verification / execution_windows.requirements / fulfillment documented); amends §4 (window machine gains system recompute transitions fulfilled↔shortfall and missed→fulfilled/shortfall); amends §5 (commitment.draft / update_spec / record.capture / window.close / record.supersede / proof.attach / assignment.set input rows concretized to the exact contracts above); annotates §8/§10/§11 (day-pack schema, outbox failure/partition semantics); DEC-009's carried draft-site item is narrowed, not closed. Doc changes via doc-PR by the operator.

---

## 5. Residual-risk note — the 3 contracts most likely to still surprise

1. **The late-record / detector interplay (F-18 × Phase 2).** F-18's recompute transitions are defined against Phase 1's world; when SLICE-025's detectors arrive, a window that late-flushes from missed→fulfilled after a no_show exception already fired creates an exception whose cause no longer exists — nothing yet defines whether it auto-resolves, stays for manual close, or double-fires on re-transition. Expect one Phase 2 CHANGE-REQUEST here regardless of this sweep.
2. **The service_scope path end-to-end.** It is the only Phase 1 flow whose data threads five contracts fixed in this single pass (spec checklist → frozen requirements → checklist proof → fulfillment → close) with no precedent slice behind any of them; a mismatch between what the capture UI can express and what the frozen keys demand will surface only when a real pilot checklist is authored — likely as a spec-authoring usability defect rather than a contract defect, which reviews catch late.
3. **Day-pack field pressure (F-14 × F29).** The pack is simultaneously offline cache, capture-UI data source, and exported read; every capture-UI iteration will want one more field in it, and F29 makes additions cheap (PR DEVIATIONS) — the surprise risk is not a missing decision but gradual PII/scope creep that no single addition looks big enough to stop. Recommend the reviewer treat any day-pack field addition touching person data as F12/§16 review scope, not a DEVIATIONS line.

---

## Item-8 reconciliation note

DEC-015 item 2 resolves draft-site visibility: draft sites are visible only to owner/manager surfaces and never appear in supervisor day-packs or client-facing surfaces. DEC-016 item 8's active-site-only day-pack schema is consistent with that resolved ruling; draft-site visibility is not carried forward.
