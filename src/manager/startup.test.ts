import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("manager startup", () => {
  it("reports startup failures as structured JSON without a plaintext Node stack", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bear-metal-startup-test-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.mjs");
    await writeFile(configPath, `export default {
      linear: { clientId: "client", getClientSecret: () => "secret" },
      github: { appId: 1, installationId: 1, getPrivateKey: () => "key" },
      database: { getUrl: () => "postgres://user:pass@127.0.0.1:1/db?connect_timeout=1" },
      llmProviders: {},
      customizeTask: () => ({ llm: { provider: "amazon-bedrock", model: "model" }, buildWorkspace: async () => {} }),
    };`);

    const child = spawn(process.execPath, ["--import", "tsx", "src/manager/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BEAR_METAL_CONFIG_FILE: configPath,
        LOG_PRETTY: "false",
        LOG_LEVEL: "info",
        API_ONLY: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));

    const lines = `${Buffer.concat(stdout)}${Buffer.concat(stderr)}`.trim().split("\n").filter(Boolean);
    expect(exitCode).toBe(1);
    expect(lines.length).toBeGreaterThan(0);
    const records = lines.map((line) => JSON.parse(line) as { level?: number; msg?: string; origin?: string });
    expect(records.some((record) => record.level === 60
      && record.msg === "fatal process error"
      && record.origin === "unhandledRejection")).toBe(true);
  }, 10_000);
});
