import coreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

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
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [...dbClientPatterns, ...coreDbPatterns] },
      ],
      // §20.7: a hardcoded user-facing string fails lint — every string a user
      // sees goes through the i18n catalog (§15).
      "react/jsx-no-literals": "error",
    },
  },
];

export default eslintConfig;
