// §6: audit_events are written by the kernel in the same transaction as the
// mutation — an action that cannot write its audit event does not commit.
// §5: the audit payload always includes invocation_id, actor, entity refs,
// and before/after diff; extras carries the catalog's Audit-extras additions
// (DEC-006).
import type { Queryable } from "../db/client";
import { uuidv7 } from "../domain/ids";
import type { Actor, AuditDraft } from "./types";

function auditActor(actor: Actor): { actorType: string; actorId: string | null } {
  switch (actor.type) {
    case "person":
      return { actorType: "person", actorId: actor.id };
    case "agent":
      return { actorType: "agent", actorId: actor.id };
    case "system":
      return { actorType: "system", actorId: null };
    case "platform":
      // DEC-007: platform actions are attributed faithfully.
      return { actorType: "platform", actorId: null };
  }
}

export async function writeAuditEvents(
  client: Queryable,
  params: {
    workspaceId: string;
    invocationId: string;
    actor: Actor;
    action: string;
    drafts: AuditDraft[];
  },
): Promise<void> {
  if (params.drafts.length === 0) {
    throw new Error(
      `${params.action} executed without an audit event — every executed action must write at least one (§6, §20.3)`,
    );
  }
  const { actorType, actorId } = auditActor(params.actor);
  for (const draft of params.drafts) {
    await client.query(
      `INSERT INTO audit_events
         (id, workspace_id, invocation_id, actor_type, actor_id, action,
          entity_type, entity_id, before, after, extras, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())`,
      [
        uuidv7(),
        params.workspaceId,
        params.invocationId,
        actorType,
        actorId,
        params.action,
        draft.entityType,
        draft.entityId,
        draft.before === undefined ? null : JSON.stringify(draft.before),
        draft.after === undefined ? null : JSON.stringify(draft.after),
        draft.extras === undefined ? null : JSON.stringify(draft.extras),
      ],
    );
  }
}
