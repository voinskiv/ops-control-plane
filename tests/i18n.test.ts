import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

import { ESLint } from "eslint";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import requestConfig from "../core/i18n/request";
import { DEFAULT_WORKSPACE_SETTINGS } from "../core/db/workspaces";
import de from "../core/i18n/de.json";
import en from "../core/i18n/en.json";

vi.mock("next-intl/server", () => ({
  getRequestConfig: (createRequestConfig: unknown) => createRequestConfig,
}));

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

function appSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return appSourceFiles(path);
    return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  });
}

function literalTranslationKeys(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const keys: string[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "t" &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      keys.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return keys;
}

describe("i18n catalog completeness (§15, §20.7)", () => {
  it("configures the canonical workspace timezone once at the request boundary", async () => {
    const config = await requestConfig({ requestLocale: Promise.resolve(undefined) });
    expect(config.timeZone).toBe(DEFAULT_WORKSPACE_SETTINGS.tz);
  });

  it("de.json contains every key of the en baseline", () => {
    const missing = flattenKeys(en).filter((key) => valueAt(de, key) === undefined);
    expect(missing).toEqual([]);
  });

  it("de.json has no empty strings", () => {
    const empty = flattenKeys(de).filter((key) => valueAt(de, key) === "");
    expect(empty).toEqual([]);
  });

  it("defines every literal t(\"...\") key referenced under app in both catalogs", () => {
    const references = appSourceFiles(join(process.cwd(), "app")).flatMap((path) =>
      literalTranslationKeys(path).map((key) => ({ key, path })),
    );
    const missing = references.flatMap(({ key, path }) =>
      ([
        valueAt(de, key) === undefined ? "de" : null,
        valueAt(en, key) === undefined ? "en" : null,
      ] as const)
        .filter((catalog): catalog is "de" | "en" => catalog !== null)
        .map((catalog) => `${catalog}:${key}:${path}`),
    );
    expect(missing).toEqual([]);
  });

  it("rejects raw unpinned Intl.DateTimeFormat under app without banning number formatting", async () => {
    const eslint = new ESLint();
    const [result] = await eslint.lintText(
      [
        `new Intl.DateTimeFormat("de").format(new Date());`,
        `new Date().toLocaleDateString("de");`,
        `new Intl.NumberFormat("de").format(1);`,
        `(1).toLocaleString("de");`,
      ].join("\n"),
      { filePath: join(process.cwd(), "app", "raw-date-format-lint-probe.ts") },
    );

    expect(result?.messages.filter((message) => message.ruleId === "no-restricted-syntax")).toHaveLength(2);
    expect(result?.messages).toContainEqual(
      expect.objectContaining({
        ruleId: "ambient-date-time/warn-bare-to-locale-string",
        severity: 1,
      }),
    );
    expect(result?.messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("Intl.NumberFormat") }),
      ]),
    );
  });
});
