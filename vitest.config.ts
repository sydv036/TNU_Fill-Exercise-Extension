import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    coverage: { include: ["src/**/*.ts", "entrypoints/**/*.ts", "entrypoints/**/*.tsx"], reporter: ["text", "html", "json-summary"] }
  }
});
