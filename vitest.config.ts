import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      DATABASE_PATH: ":memory:",
      PRIVATE_STORAGE_PATH: "./.vitest/private",
      CONFIG_PATH: "./.vitest/config",
      APP_SECRET: "test-secret-do-not-use-in-production-0123456789",
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
