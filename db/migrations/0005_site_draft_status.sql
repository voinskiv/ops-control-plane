-- 0005_site_draft_status.sql — DEC-009 (2026-07-08), Q1/Q2: sites gain a
-- non-billable 'draft' state so site.create (proposal_gated) can create a
-- site without moving the §9 [FIXED] active-site billing meter. site.create
-- writes 'draft'; site.activate (human_only) is the sole transition onto
-- 'active' and therefore the sole meter-moving event. site.archive stays
-- deferred per DEC-008/DEC-009.
ALTER TYPE site_status ADD VALUE 'draft' BEFORE 'active';
