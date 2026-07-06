// Application wiring: one kernel instance over the application-wide registry
// and the Phase 0 noop-unlimited entitlement resolver (§19 Phase 0).
import { createKernelDb } from "../db/kernel";
import { noopUnlimitedResolver } from "./entitlement";
import { Kernel } from "./kernel";
import { registry } from "./registry";

let kernel: Kernel | null = null;

export function getKernel(): Kernel {
  if (kernel === null) {
    const connectionString = process.env.DATABASE_URL;
    if (connectionString === undefined || connectionString === "") {
      throw new Error("DATABASE_URL is not configured");
    }
    kernel = new Kernel(createKernelDb(connectionString), registry, noopUnlimitedResolver);
  }
  return kernel;
}
