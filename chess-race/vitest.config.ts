import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom", // or "node" if you're not testing DOM
    // A concrete origin so localStorage/sessionStorage work in jsdom.
    environmentOptions: { jsdom: { url: "http://localhost:3000/" } },
    setupFiles: "./src/setupTests.ts",
    testTimeout: 15_000, // give extra time for real connections
    hookTimeout: 15_000,
  },
});
