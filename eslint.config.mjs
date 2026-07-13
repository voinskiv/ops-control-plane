import coreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// react/jsx-no-literals catches rendered JSX text, but its attribute option is
// all-or-nothing. This companion applies the same catalog-only policy to every
// string-valued prop except this technical/non-rendered allowlist: className,
// id, type, name, href, rel, target, key, data-*, lang, dir, role,
// autoComplete, htmlFor, method/action/formAction/encType, value, endpoint,
// src, accept, inputMode, pattern, step/min/max/minLength/maxLength,
// width/height/tabIndex, download/crossOrigin/referrerPolicy/loading/decoding/
// fetchPriority/as, and technical ARIA state/reference props (aria-hidden,
// aria-live, aria-labelledby, aria-describedby, aria-controls, aria-current).
// User-facing placeholder, aria-label, alt, title, and label are deliberately
// absent, so literal values for them fail lint and must come from the catalog.
const technicalJsxAttributes = new Set([
  "className", "id", "type", "name", "href", "rel", "target", "key",
  "lang", "dir", "role", "autoComplete", "htmlFor", "method", "action",
  "formAction", "encType", "value", "endpoint", "src", "accept", "inputMode",
  "pattern", "step", "min", "max", "minLength", "maxLength", "width",
  "height", "tabIndex", "download", "crossOrigin", "referrerPolicy", "loading",
  "decoding", "fetchPriority", "as", "aria-hidden", "aria-live",
  "aria-labelledby", "aria-describedby", "aria-controls", "aria-current",
]);

const catalogJsxAttributesPlugin = {
  rules: {
    "no-user-facing-literals": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          catalog: "User-facing JSX attribute values must come from the i18n catalog.",
        },
      },
      create(context) {
        return {
          JSXAttribute(node) {
            if (node.name.type !== "JSXIdentifier") return;
            const attributeName = node.name.name;
            if (technicalJsxAttributes.has(attributeName) || attributeName.startsWith("data-")) return;

            const value = node.value;
            const directLiteral = value?.type === "Literal" || value?.type === "StringLiteral";
            const expression = value?.type === "JSXExpressionContainer" ? value.expression : null;
            const expressionLiteral = expression?.type === "Literal" || expression?.type === "StringLiteral";
            const staticTemplate = expression?.type === "TemplateLiteral" && expression.expressions.length === 0;
            if (directLiteral || expressionLiteral || staticTemplate) {
              context.report({ node, messageId: "catalog" });
            }
          },
        };
      },
    },
  },
};

// §20.5: the db client may only be imported inside core/db — it is "the only
// db import site" (§19). Patterns cover the clients named by the architecture
// (Drizzle, Supabase) and the underlying Postgres drivers.
const dbClientPatterns = [
  {
    group: ["drizzle-orm", "drizzle-orm/*", "postgres", "pg", "pg/*", "@supabase/*"],
    message:
      "Database/Supabase clients may only be imported inside core/db (§19, §20.5).",
  },
];

// §20.5: app/ may not import core/db — components call actions and reads only
// (§19 handoff constraint 6).
const coreDbPatterns = [
  {
    group: ["@core/db", "@core/db/*", "**/core/db", "**/core/db/*"],
    message:
      "app/ must not import core/db — call actions and reads instead (§20.5).",
  },
];

const eslintConfig = [
  ...coreWebVitals,
  ...nextTypescript,
  {
    ignores: [".claude/**", ".next/**", "node_modules/**", "next-env.d.ts"],
  },
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    ignores: ["core/db/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: dbClientPatterns }],
    },
  },
  {
    files: ["app/**/*.{ts,tsx}"],
    plugins: {
      "catalog-jsx-attributes": catalogJsxAttributesPlugin,
    },
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [...dbClientPatterns, ...coreDbPatterns] },
      ],
      // §20.7: a hardcoded user-facing string fails lint — every string a user
      // sees goes through the i18n catalog (§15).
      "react/jsx-no-literals": "error",
      "catalog-jsx-attributes/no-user-facing-literals": "error",
    },
  },
];

export default eslintConfig;
