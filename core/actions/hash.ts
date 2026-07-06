// §5 idempotency: the same key with a different input_hash is a typed
// rejection (F24). The hash is sha256 over a canonical JSON form (sorted
// object keys) so semantically identical inputs hash identically.
import { createHash } from "node:crypto";

function canonicalize(value: unknown): string {
  if (value === undefined || typeof value === "function") {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry ?? null)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`);
  return `{${entries.join(",")}}`;
}

export function inputHash(input: unknown): string {
  return createHash("sha256").update(canonicalize(input)).digest("hex");
}
