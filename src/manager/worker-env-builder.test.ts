import { beforeEach, describe, expect, it, vi } from "vitest";

const commandMock = vi.hoisted(() => ({
  runCommand: vi.fn(async () => ({ stdout: "", stderr: "" })),
}));

vi.mock("../shared/command.js", () => ({
  runCommand: commandMock.runCommand,
}));

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as import("../shared/index.js").Logger;
}

describe("runWorkerEnvironmentBuilder", () => {
  beforeEach(() => {
    commandMock.runCommand.mockReset();
    commandMock.runCommand.mockResolvedValue({ stdout: "", stderr: "" });
  });

  it("is a no-op when neither command nor path is provided", async () => {
    const { runWorkerEnvironmentBuilder } = await import("./worker-env-builder.js");
    await runWorkerEnvironmentBuilder({ logger: makeLogger() });
    expect(commandMock.runCommand).not.toHaveBeenCalled();
  });

  it("runs the inline command through bash", async () => {
    const { runWorkerEnvironmentBuilder } = await import("./worker-env-builder.js");
    await runWorkerEnvironmentBuilder({ command: "echo hello", logger: makeLogger() });
    expect(commandMock.runCommand).toHaveBeenCalledTimes(1);
    expect(commandMock.runCommand).toHaveBeenCalledWith(
      "bash",
      [expect.stringMatching(/worker-environment-builder\.sh$/)],
      expect.objectContaining({ cwd: process.cwd(), timeoutMs: expect.any(Number) }),
    );
  });

  it("runs the provided script path through bash", async () => {
    const { runWorkerEnvironmentBuilder } = await import("./worker-env-builder.js");
    await runWorkerEnvironmentBuilder({ path: "/scripts/install.sh", logger: makeLogger() });
    expect(commandMock.runCommand).toHaveBeenCalledWith(
      "bash",
      ["/scripts/install.sh"],
      expect.objectContaining({ cwd: process.cwd() }),
    );
  });

  it("throws when both command and path are provided", async () => {
    const { runWorkerEnvironmentBuilder } = await import("./worker-env-builder.js");
    await expect(
      runWorkerEnvironmentBuilder({ command: "echo hi", path: "/scripts/install.sh", logger: makeLogger() }),
    ).rejects.toThrow(/mutually exclusive/);
    expect(commandMock.runCommand).not.toHaveBeenCalled();
  });

  it("propagates the failure when the builder exits non-zero", async () => {
    commandMock.runCommand.mockRejectedValueOnce(new Error("Command failed (1): bash"));
    const logger = makeLogger();
    const { runWorkerEnvironmentBuilder } = await import("./worker-env-builder.js");
    await expect(
      runWorkerEnvironmentBuilder({ command: "exit 1", logger }),
    ).rejects.toThrow(/Command failed/);
    expect(logger.error).toHaveBeenCalled();
  });
});
