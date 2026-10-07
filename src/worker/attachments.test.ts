import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadTicketAttachments } from "./attachments.js";

describe("downloadTicketAttachments", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
    vi.unstubAllGlobals();
  });

  it("downloads every attachment and returns compact local metadata", async () => {
    directory = await mkdtemp(join(tmpdir(), "bear-metal-evidence-"));
    const largePayload = new Uint8Array(2_000_000).fill(97);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(largePayload, { headers: { "content-length": String(largePayload.length) } }))
      .mockResolvedValueOnce(new Response("report", { headers: { "content-length": "6" } }));
    vi.stubGlobal("fetch", fetchMock);

    const downloaded = await downloadTicketAttachments(
      [
        { id: "a1", title: "logs/failure.log", url: "https://uploads.linear.app/a1" },
        { id: "a2", title: "../report.json", url: "https://uploads.linear.app/a2" },
      ],
      directory,
      "test-token",
    );

    expect(downloaded).toEqual([
      { title: "logs/failure.log", path: join(directory, "001-logs_failure.log"), size: 2_000_000 },
      { title: "../report.json", path: join(directory, "002-.._report.json"), size: 6 },
    ]);
    expect((await readFile(downloaded[0]!.path)).byteLength).toBe(2_000_000);
    expect(JSON.stringify(downloaded)).not.toContain("aaaa");
    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://uploads.linear.app/a1", {
      headers: { Authorization: "Bearer test-token" },
    });
  });

  it("fails when a downloaded size differs from Linear's response", async () => {
    directory = await mkdtemp(join(tmpdir(), "bear-metal-evidence-"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("short", { headers: { "content-length": "99" } })));

    await expect(
      downloadTicketAttachments(
        [{ id: "a1", title: "failure.log", url: "https://uploads.linear.app/a1" }],
        directory,
        "test-token",
      ),
    ).rejects.toThrow(/size mismatch/);
  });

  it("fails visibly when Linear rejects the attachment token", async () => {
    directory = await mkdtemp(join(tmpdir(), "bear-metal-evidence-"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

    await expect(
      downloadTicketAttachments(
        [{ id: "a1", title: "failure.log", url: "https://uploads.linear.app/a1" }],
        directory,
        "expired-token",
      ),
    ).rejects.toThrow("Failed to download Linear attachment failure.log: HTTP 401");
  });
});
