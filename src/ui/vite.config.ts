/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const version =
  process.env.APP_VERSION ??
  (JSON.parse(readFileSync("../../package.json", "utf-8")) as { version: string }).version;

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5273,
    proxy: { "/api": process.env.BACKEND_URL ?? "http://localhost:3100" },
  },
  test: {
    css: true,
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
