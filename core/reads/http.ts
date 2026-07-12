import type { ActorResolution } from "../auth/session";
import type { ReadKernel } from "./kernel";
import { readHttpStatus } from "./kernel";
import { readRejected } from "./types";

export async function handleReadsGet(
  reads: ReadKernel,
  resolved: ActorResolution,
  name: string,
  params: unknown,
): Promise<{ httpStatus: number; body: unknown }> {
  if (resolved.actor === null) {
    const envelope = readRejected(resolved.rejection ?? "unauthenticated");
    return { httpStatus: readHttpStatus(envelope), body: envelope };
  }
  const result = await reads.dispatch(resolved.actor, name, params);
  if (result.ok) {
    return { httpStatus: 200, body: result.data };
  }
  return { httpStatus: readHttpStatus(result.envelope), body: result.envelope };
}
