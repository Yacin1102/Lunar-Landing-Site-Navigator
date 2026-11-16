import { defineConfig } from "vitest/config";

// Configure Vitest with the same TypeScript module rules used by the app.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["engine/**/*.test.ts", "scripts/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
