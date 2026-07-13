import { getAuthDb } from "../auth/runtime";
import { getKernel } from "./runtime";
import { generateRollingWindows, openDueWindows } from "./window-cron";

export function runWindowGeneration(): Promise<void> {
  return generateRollingWindows(getAuthDb(), getKernel());
}

export function runWindowOpening(): Promise<void> {
  return openDueWindows(getAuthDb(), getKernel());
}
