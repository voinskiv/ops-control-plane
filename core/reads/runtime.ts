import { getAuthDb } from "../auth/runtime";
import { ReadKernel } from "./kernel";
import { readRegistry } from "./registry";

let reads: ReadKernel | null = null;

export function getReads(): ReadKernel {
  if (reads === null) {
    reads = new ReadKernel(getAuthDb(), readRegistry);
  }
  return reads;
}
