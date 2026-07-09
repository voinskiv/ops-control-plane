// SLICE-006: person.* actions per §5 catalog and DEC-008.
import { z } from "zod";

import {
  activeOwnerCount,
  createPersonRow,
  linkAuthUserToPerson,
  lockWorkspaceForOwnerGuard,
  personById,
  PSEUDONYMIZE_CLEARED_FIELDS,
  pseudonymizedDisplayName,
  revokeNonRevokedAuthDevices,
  updatePersonRow,
  workspaceDefaultLocale,
  type PersonPatch,
  type PersonSnapshot,
  type RoleClass,
} from "../db/persons";
import { uuidv7 } from "../domain/ids";
import { getAuthTransport } from "../auth/transport";
import { outcomeRejected, type ActionDefinition, type Actor, type AuditDraft, type ExecContext } from "./types";

const roleClassInput = z.enum(["owner", "manager", "supervisor", "worker"]);
const localeInput = z.enum(["de", "en"]);
const displayNameInput = z.string().trim().min(1).max(200);
const emailInput = z.string().trim().max(254);
const phoneInput = z.string().trim().max(50);
const reasonInput = z.string().trim().min(1).max(2000);

const personCreateInput = z
  .object({
    display_name: displayNameInput,
    role_class: roleClassInput,
    email: emailInput.optional(),
    phone: phoneInput.optional(),
    locale: localeInput.optional(),
  })
  .strict();

const personUpdateInput = z
  .object({
    person_id: z.uuid(),
    display_name: displayNameInput.optional(),
    role_class: roleClassInput.optional(),
    email: emailInput.nullable().optional(),
    phone: phoneInput.nullable().optional(),
    locale: localeInput.optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.display_name !== undefined ||
      input.role_class !== undefined ||
      input.email !== undefined ||
      input.phone !== undefined ||
      input.locale !== undefined,
    { message: "empty patch" },
  );

const personDeactivateInput = z
  .object({
    person_id: z.uuid(),
    reason: reasonInput,
  })
  .strict();

const legalBasisInput = z
  .object({
    kind: z.enum(["data_subject_request", "retention_policy", "other"]),
    note: reasonInput,
  })
  .strict();

const personPseudonymizeInput = z
  .object({
    person_id: z.uuid(),
    legal_basis: legalBasisInput,
  })
  .strict();

const personInviteInput = z
  .object({
    person_id: z.uuid(),
  })
  .strict();

const personLinkAuthInput = z
  .object({
    person_id: z.uuid(),
    auth_user_id: z.uuid(),
    email: emailInput,
  })
  .strict();

function workspaceId(ctx: ExecContext): string {
  if (ctx.workspaceId === null) {
    throw new Error("person action executed without a workspace id");
  }
  return ctx.workspaceId;
}

function actorIsOwner(actor: Actor): boolean {
  return actor.type === "person" && actor.roleClass === "owner";
}

function ownerRoleOperationAllowed(actor: Actor, targetRole: RoleClass, nextRole?: RoleClass): boolean {
  if (targetRole !== "owner" && nextRole !== "owner") {
    return true;
  }
  return actorIsOwner(actor);
}

async function lastActiveOwnerProtected(ctx: ExecContext, target: PersonSnapshot): Promise<boolean> {
  if (target.role_class !== "owner" || target.status !== "active") {
    return false;
  }
  const locked = await lockWorkspaceForOwnerGuard(ctx.tx, target.workspace_id);
  if (!locked) {
    return true;
  }
  return (await activeOwnerCount(ctx.tx, target.workspace_id)) <= 1;
}

function roleChange(from: RoleClass | null, to: RoleClass): { role_change: { from: RoleClass | null; to: RoleClass } } {
  return { role_change: { from, to } };
}

function isInvitableRole(roleClass: RoleClass): boolean {
  return roleClass === "owner" || roleClass === "manager";
}

function hasEmail(email: string | null): boolean {
  return (email ?? "").trim().length > 0;
}

function updatePatchAndDiff(
  input: z.infer<typeof personUpdateInput>,
  before: PersonSnapshot,
): {
  patch: PersonPatch;
  beforeDiff: Record<string, unknown>;
  fields: Array<"display_name" | "role_class" | "email" | "phone" | "locale">;
} {
  const patch: PersonPatch = {};
  const beforeDiff: Record<string, unknown> = {};
  const fields: Array<"display_name" | "role_class" | "email" | "phone" | "locale"> = [];

  if (input.display_name !== undefined) {
    patch.displayName = input.display_name;
    beforeDiff.display_name = before.display_name;
    fields.push("display_name");
  }
  if (input.role_class !== undefined) {
    patch.roleClass = input.role_class;
    beforeDiff.role_class = before.role_class;
    fields.push("role_class");
  }
  if (input.email !== undefined) {
    patch.email = input.email;
    beforeDiff.email = before.email;
    fields.push("email");
  }
  if (input.phone !== undefined) {
    patch.phone = input.phone;
    beforeDiff.phone = before.phone;
    fields.push("phone");
  }
  if (input.locale !== undefined) {
    patch.locale = input.locale;
    beforeDiff.locale = before.locale;
    fields.push("locale");
  }

  return { patch, beforeDiff, fields };
}

function afterDiff(
  after: PersonSnapshot,
  fields: Array<"display_name" | "role_class" | "email" | "phone" | "locale">,
): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  for (const field of fields) {
    diff[field] = after[field];
  }
  return diff;
}

export const personCreateAction: ActionDefinition<z.infer<typeof personCreateInput>> = {
  name: "person.create",
  actors: { minHumanRole: "manager" },
  threshold: "proposal_gated",
  input: personCreateInput,
  async execute(ctx, input) {
    if (!ownerRoleOperationAllowed(ctx.actor, input.role_class, input.role_class)) {
      return outcomeRejected("unauthorized");
    }

    const defaultLocale = await workspaceDefaultLocale(ctx.tx, workspaceId(ctx));
    if (defaultLocale === null) {
      return outcomeRejected("validation_failed");
    }

    const person = await createPersonRow(ctx.tx, {
      id: uuidv7(),
      workspaceId: workspaceId(ctx),
      displayName: input.display_name,
      roleClass: input.role_class,
      email: input.email,
      phone: input.phone,
      locale: input.locale ?? defaultLocale,
    });

    return {
      result: { person_id: person.id },
      warnings: isInvitableRole(person.role_class) && !hasEmail(person.email) ? ["no_email_for_invitable_role"] : [],
      audit: [
        {
          entityType: "persons",
          entityId: person.id,
          after: person,
          extras: roleChange(null, person.role_class),
        },
      ],
    };
  },
};

export const personUpdateAction: ActionDefinition<z.infer<typeof personUpdateInput>> = {
  name: "person.update",
  actors: { minHumanRole: "manager" },
  threshold: "proposal_gated",
  input: personUpdateInput,
  async execute(ctx, input) {
    const target = await personById(ctx.tx, workspaceId(ctx), input.person_id);
    if (target === null) {
      return outcomeRejected("validation_failed");
    }
    if (target.status === "pseudonymized") {
      return outcomeRejected("validation_failed");
    }

    const nextRole = input.role_class ?? target.role_class;
    if (!ownerRoleOperationAllowed(ctx.actor, target.role_class, nextRole)) {
      return outcomeRejected("unauthorized");
    }
    if (target.role_class === "owner" && nextRole !== "owner" && (await lastActiveOwnerProtected(ctx, target))) {
      return outcomeRejected("last_owner_protected");
    }

    const { patch, beforeDiff, fields } = updatePatchAndDiff(input, target);
    const updated = await updatePersonRow(ctx.tx, workspaceId(ctx), target.id, patch);
    const extras = target.role_class !== updated.role_class ? roleChange(target.role_class, updated.role_class) : undefined;

    return {
      result: { person_id: updated.id },
      audit: [
        {
          entityType: "persons",
          entityId: updated.id,
          before: beforeDiff,
          after: afterDiff(updated, fields),
          extras,
        },
      ],
    };
  },
};

export const personDeactivateAction: ActionDefinition<z.infer<typeof personDeactivateInput>> = {
  name: "person.deactivate",
  actors: { minHumanRole: "manager" },
  threshold: "human_only",
  input: personDeactivateInput,
  async execute(ctx, input) {
    const target = await personById(ctx.tx, workspaceId(ctx), input.person_id);
    if (target === null) {
      return outcomeRejected("validation_failed");
    }
    if (target.status !== "active") {
      return outcomeRejected("validation_failed");
    }
    if (!ownerRoleOperationAllowed(ctx.actor, target.role_class)) {
      return outcomeRejected("unauthorized");
    }
    if (await lastActiveOwnerProtected(ctx, target)) {
      return outcomeRejected("last_owner_protected");
    }

    const updated = await updatePersonRow(ctx.tx, workspaceId(ctx), target.id, { status: "inactive" });
    return {
      result: { person_id: updated.id },
      audit: [
        {
          entityType: "persons",
          entityId: updated.id,
          before: { status: target.status },
          after: { status: updated.status },
          extras: { reason: input.reason },
        },
      ],
    };
  },
};

export const personPseudonymizeAction: ActionDefinition<z.infer<typeof personPseudonymizeInput>> = {
  name: "person.pseudonymize",
  actors: { minHumanRole: "owner" },
  threshold: "human_only",
  input: personPseudonymizeInput,
  async execute(ctx, input) {
    const target = await personById(ctx.tx, workspaceId(ctx), input.person_id);
    if (target === null) {
      return outcomeRejected("validation_failed");
    }
    if (target.status === "pseudonymized") {
      return outcomeRejected("validation_failed");
    }
    if (await lastActiveOwnerProtected(ctx, target)) {
      return outcomeRejected("last_owner_protected");
    }

    const defaultLocale = await workspaceDefaultLocale(ctx.tx, workspaceId(ctx));
    if (defaultLocale === null) {
      return outcomeRejected("validation_failed");
    }

    const updated = await updatePersonRow(ctx.tx, workspaceId(ctx), target.id, {
      displayName: pseudonymizedDisplayName(target.id),
      email: null,
      phone: null,
      pinHash: null,
      authUserId: null,
      locale: defaultLocale,
      status: "pseudonymized",
    });
    const revokedDevices = await revokeNonRevokedAuthDevices(ctx.tx, workspaceId(ctx), target.id);
    const clearedFields = [...PSEUDONYMIZE_CLEARED_FIELDS];
    const audit: AuditDraft[] = [
      {
        entityType: "persons",
        entityId: updated.id,
        before: { cleared_fields: clearedFields },
        after: {
          display_name: updated.display_name,
          email: updated.email,
          phone: updated.phone,
          pin_hash: updated.pin_hash,
          auth_user_id: updated.auth_user_id,
          locale: updated.locale,
          status: updated.status,
        },
        extras: { legal_basis: input.legal_basis, cleared_fields: clearedFields },
      },
      ...revokedDevices.map((device): AuditDraft => ({
        entityType: "auth_devices",
        entityId: device.id,
        before: { status: device.beforeStatus },
        after: { status: "revoked" },
      })),
    ];

    return {
      result: { person_id: updated.id },
      audit,
    };
  },
};

export const personInviteAction: ActionDefinition<z.infer<typeof personInviteInput>> = {
  name: "person.invite",
  actors: { minHumanRole: "manager" },
  threshold: "human_only",
  input: personInviteInput,
  async execute(ctx, input) {
    const target = await personById(ctx.tx, workspaceId(ctx), input.person_id);
    if (
      target === null ||
      target.status !== "active" ||
      (target.role_class !== "owner" && target.role_class !== "manager") ||
      !hasEmail(target.email)
    ) {
      return outcomeRejected("invite_ineligible");
    }
    if (target.auth_user_id !== null) {
      return outcomeRejected("auth_already_linked");
    }

    const invite = await getAuthTransport().sendInvite({
      email: target.email ?? "",
      workspaceId: target.workspace_id,
      personId: target.id,
    });

    return {
      result: { person_id: target.id },
      audit: [
        {
          entityType: "persons",
          entityId: target.id,
          after: { auth_user_id: target.auth_user_id },
          extras: { auth_invite_id: invite.inviteId },
        },
      ],
    };
  },
};

export const personLinkAuthOperation: ActionDefinition<z.infer<typeof personLinkAuthInput>> = {
  name: "person.link_auth",
  actors: { system: true },
  threshold: "human_only",
  input: personLinkAuthInput,
  async execute(ctx, input) {
    const linked = await linkAuthUserToPerson(ctx.tx, {
      workspaceId: workspaceId(ctx),
      personId: input.person_id,
      authUserId: input.auth_user_id,
      email: input.email,
    });
    if ("rejected" in linked) {
      return outcomeRejected(linked.rejected);
    }

    return {
      result: { person_id: linked.person.id },
      audit: [
        {
          entityType: "persons",
          entityId: linked.person.id,
          before: { auth_user_id: null },
          after: { auth_user_id: linked.person.auth_user_id },
        },
      ],
    };
  },
};
