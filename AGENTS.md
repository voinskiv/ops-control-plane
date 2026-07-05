You are implementing this product strictly inside ARCHITECTURE.md, which is the
binding source of truth. Treat it as read-only. Never edit it. Amendments
(including syncing a DECISIONS.md entry back into it) are applied by the human
only — you never edit ARCHITECTURE.md, even to reconcile it with a decision.

SCOPE
- Build only what ARCHITECTURE.md defines. Do not add features, endpoints,
  abstractions, generalizations of specified behavior (optional parameters,
  flags, broader defaults, pass-through fields), or "helpful" extras outside
  it, even if they seem obvious.
- Respect all product boundaries and exclusions in the architecture.
- A new read or endpoint that widens *who can see what* is SECURITY/AUTHZ
  scope and follows the AMBIGUITY rule below, regardless of any architecture
  note classifying reads as non-scope-breaking.

AMBIGUITY
- If the architecture is ambiguous about, or silent on, an IMPLEMENTATION
  detail (naming, structure, libraries, internal types, tests), choose the
  smallest safe technical interpretation, proceed, and record it in the PR
  under "Decisions made" and as a one-line note in DECISIONS.md. Smallest
  safe = the most reversible option granting the least capability and
  exposure; if candidate interpretations differ in what any actor can see or
  do, it is not an implementation detail — stop instead. If a decision
  arguably fits both this list and the list below, or is visible outside the
  code (API/action names, stored data formats, tokens, error responses,
  logged fields), treat it as the list below.
- If the ambiguity affects PRODUCT behavior, DOMAIN model, ACTION kernel,
  AUDIT model, TENANCY, PRIVACY/PII, or SECURITY/AUTHZ — including a
  security-relevant constant not listed in Appendix A, or classifying a
  message template as sensitive/non-sensitive — STOP. Do not guess. Emit a
  CHANGE-REQUEST (see below) and wait.
- Any note elsewhere in the repo marked "confirm" or phrased as an assumption
  (e.g. PROGRESS.md "Bootstrap ambiguities") is an open question, not a
  decision — do not build on it until a RESOLVED entry exists in
  DECISIONS.md.

CHANGE-REQUEST FORMAT
  CHANGE-REQUEST
  - Blocking question:
  - Architecture section(s) involved:
  - Options considered: every option a reviewer might reasonably choose, each
    with the consequence that would make a human pick it
  - Smallest-safe default (if allowed to proceed): must remain valid under
    every option listed above; if none exists, write "none — hard blocked"
  - Why this needs human sign-off: name the category from AMBIGUITY affected
    and the concrete harm if the default is wrong
Emit the CHANGE-REQUEST, log it to DECISIONS.md as Status: OPEN with the
Question filled in, before writing any code the answer could change — never
as an annotation on a PR where that code already exists. Do not continue work
on anything the answer could change; unrelated slices may proceed. Only a
human's answer, or an agent transcribing it verbatim and naming the approver,
may fill in Resolution and flip Status to RESOLVED — never author a
Resolution yourself. Treat DECISIONS.md as an extension of the architecture.

WORKFLOW
- Work one vertical slice per task: schema (Phase 0 only; afterwards schema
  and any §19 frozen path changes only via CHANGE-REQUEST)/handler/logic +
  tests + audit, end-to-end, tests green.
- The §19 handoff block's numbered constraints bind every task, whether or
  not this task came with a phase brief attached.
- One slice = one PR, following the PR template at
  .github/PULL_REQUEST_TEMPLATE.md.
- Update PROGRESS.md when a slice completes: check the box and append a
  status line only. Never edit a slice's "Done when" or scope text — that
  requires a CHANGE-REQUEST.
- Never carry assumptions between tasks; the repo is the only state.

QUALITY GATES
- Lint, typecheck, and tests must pass before opening a PR, without weakening
  any gate — skipping, deleting, or loosening a test, lint rule, or CI check
  requires a CHANGE-REQUEST.
- Every PR must cite the specific ARCHITECTURE.md sentence or table row that
  requires the behavior — a section that merely mentions the topic does not
  count. No citation means out of scope — do not do it.
