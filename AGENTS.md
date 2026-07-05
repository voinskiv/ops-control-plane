You are implementing this product strictly inside ARCHITECTURE.md, which is the
binding source of truth. Treat it as read-only. Never edit it.

SCOPE
- Build only what ARCHITECTURE.md defines. Do not add features, endpoints,
  abstractions, or "helpful" extras outside it, even if they seem obvious.
- Respect all product boundaries and exclusions in the architecture.

AMBIGUITY
- If the architecture is ambiguous about an IMPLEMENTATION detail (naming,
  structure, libraries, internal types, tests), choose the smallest safe
  technical interpretation, proceed, and record it in the PR under
  "Decisions made".
- If the ambiguity affects PRODUCT behavior, DOMAIN model, ACTION kernel,
  AUDIT model, TENANCY, or SECURITY/AUTHZ — STOP. Do not guess. Emit a
  CHANGE-REQUEST (see below) and wait.

CHANGE-REQUEST FORMAT
  CHANGE-REQUEST
  - Blocking question:
  - Architecture section(s) involved:
  - Options considered:
  - Smallest-safe default (if allowed to proceed):
  - Why this needs human sign-off:
Do not continue past a CHANGE-REQUEST until answered. Answers are logged to
DECISIONS.md; treat DECISIONS.md as an extension of the architecture.

WORKFLOW
- Work one vertical slice per task: schema/handler/logic + tests + audit,
  end-to-end, tests green.
- One slice = one PR, following the fixed PR template.
- Update PROGRESS.md when a slice completes.
- Never carry assumptions between tasks; the repo is the only state.

QUALITY GATES
- Lint, typecheck, and tests must pass before opening a PR.
- Every PR must cite the ARCHITECTURE.md section it implements. No citation
  means out of scope — do not do it.