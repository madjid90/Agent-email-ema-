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
      MICROSOFT_CLIENT_ID: "test-client-id",
      MICROSOFT_CLIENT_SECRET: "test-client-secret",
      MICROSOFT_TENANT_ID: "common",
      MICROSOFT_REDIRECT_URI: "http://localhost:3000/api/integrations/microsoft/callback",
      EMAIL_SYNC_LIMIT: "50",
      ATTACHMENT_MAX_MB: "1",
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
