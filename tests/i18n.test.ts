import { describe, expect, it } from "vitest";
import de from "../core/i18n/de.json";
import en from "../core/i18n/en.json";

// §15: de is the completeness-enforced catalog (CI gate); en is the developer
// baseline. This test is the "de.json completeness check" of §20.7.

function flattenKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object") {
      return flattenKeys(value as Record<string, unknown>, path);
    }
    return [path];
  });
}

function valueAt(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) => (node as Record<string, unknown> | undefined)?.[key],
      obj,
    );
}

describe("i18n catalog completeness (§15, §20.7)", () => {
  it("de.json contains every key of the en baseline", () => {
    const missing = flattenKeys(en).filter((key) => valueAt(de, key) === undefined);
    expect(missing).toEqual([]);
  });

  it("de.json has no empty strings", () => {
    const empty = flattenKeys(de).filter((key) => valueAt(de, key) === "");
    expect(empty).toEqual([]);
  });
});
