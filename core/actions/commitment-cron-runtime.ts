import { getAuthDb } from "../auth/runtime";
import { getKernel } from "./runtime";
import { completeDueCommitments } from "./commitment-cron";

export function runDueCommitmentCompletion(): Promise<void> {
  return completeDueCommitments(getAuthDb(), getKernel());
}
