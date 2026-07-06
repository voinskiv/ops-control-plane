// §9: entitlement enforcement lives only in the kernel's entitlement gate;
// actions declare needs and one resolver checks them against plans.limits.
// §19 Phase 0 ships entitlements-as-noop-unlimited; SLICE-040 replaces the
// resolver with the real plans.limits check.
import type { ActionDefinition, Actor, RejectionCode } from "./types";

export interface EntitlementResolver {
  check(actor: Actor, definition: ActionDefinition): Promise<RejectionCode | null>;
}

export const noopUnlimitedResolver: EntitlementResolver = {
  async check(): Promise<RejectionCode | null> {
    return null;
  },
};
