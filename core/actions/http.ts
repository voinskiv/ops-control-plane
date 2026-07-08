// §5: the HTTP surface is POST /api/actions with {name, input,
// idempotency_key} returning the {status, result, warnings} envelope. The
// route handler in app/ is a thin mount over this (§19 handoff constraint 6).
import { z } from "zod";

import type { Kernel } from "./kernel";
import { envelopeRejected, type Actor, type ResponseEnvelope } from "./types";

const bodySchema = z.object({
  name: z.string().min(1),
  input: z.unknown(),
  idempotency_key: z.string().min(1),
});

const REJECTION_HTTP_STATUS: Record<string, number> = {
  unauthenticated: 401,
  unauthorized: 403,
  no_dashboard_membership: 403,
  auth_email_mismatch: 403,
  idempotency_conflict: 409,
  last_owner_protected: 409,
  auth_already_linked: 409,
};

function httpStatusFor(envelope: ResponseEnvelope): number {
  if (envelope.status === "ok") {
    return 200;
  }
  if (envelope.status === "error") {
    return 500;
  }
  const code = (envelope.result as { code?: string } | null)?.code ?? "";
  return REJECTION_HTTP_STATUS[code] ?? 400;
}

export async function handleActionsPost(
  getKernel: () => Kernel,
  actor: Actor | null,
  body: unknown,
): Promise<{ httpStatus: number; envelope: ResponseEnvelope }> {
  if (actor === null) {
    return { httpStatus: 401, envelope: envelopeRejected("unauthenticated") };
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return { httpStatus: 400, envelope: envelopeRejected("validation_failed") };
  }
  const envelope = await getKernel().dispatch(actor, {
    name: parsed.data.name,
    input: parsed.data.input,
    idempotencyKey: parsed.data.idempotency_key,
  });
  return { httpStatus: httpStatusFor(envelope), envelope };
}
