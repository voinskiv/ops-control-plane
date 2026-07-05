import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@core": fileURLToPath(new URL("./core", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/helpers/global-setup.ts"],
  },
});
