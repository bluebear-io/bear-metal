import { mkdtemp, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_EVIDENCE_BYTES, readEvidenceFile } from "./evidence.js";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const WEBM_BYTES = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
const MP4_BYTES = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const MP4_FREE_FIRST_BYTES = new Uint8Array([0, 0, 0, 0x08, 0x66, 0x72, 0x65, 0x65, ...MP4_BYTES]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0xff, 0xd9]);

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "bear-metal-evidence-"));
});

describe("readEvidenceFile", () => {
  it("reads supported screenshots and videos by workspace-relative or absolute path", async () => {
    await writeFile(join(workspace, "shot.png"), PNG_BYTES);
    await writeFile(join(workspace, "clip.webm"), WEBM_BYTES);
    await writeFile(join(workspace, "clip.mp4"), MP4_BYTES);

    await expect(readEvidenceFile(workspace, "shot.png")).resolves.toEqual({ filename: "shot.png", contentType: "image/png", data: PNG_BYTES });
    await expect(readEvidenceFile(workspace, join(workspace, "clip.webm"))).resolves.toMatchObject({ contentType: "video/webm" });
    await expect(readEvidenceFile(workspace, "clip.mp4")).resolves.toMatchObject({ contentType: "video/mp4" });
  });

  it("accepts an MP4 whose ftyp box follows another box and a JPEG ending in EOI", async () => {
    await writeFile(join(workspace, "free-first.mp4"), MP4_FREE_FIRST_BYTES);
    await writeFile(join(workspace, "shot.jpg"), JPEG_BYTES);

    await expect(readEvidenceFile(workspace, "free-first.mp4")).resolves.toMatchObject({ contentType: "video/mp4" });
    await expect(readEvidenceFile(workspace, "shot.jpg")).resolves.toMatchObject({ contentType: "image/jpeg" });
  });

  it("rejects a JPEG signature without an end-of-image marker", async () => {
    await writeFile(join(workspace, "truncated.jpg"), JPEG_BYTES.subarray(0, 6));
    await expect(readEvidenceFile(workspace, "truncated.jpg")).rejects.toThrow("Evidence file content is not image/jpeg");
  });

  it("rejects file types that are not screenshots or videos", async () => {
    await writeFile(join(workspace, "notes.txt"), "hello");
    await expect(readEvidenceFile(workspace, "notes.txt")).rejects.toThrow('Unsupported evidence file type ".txt"');
  });

  it("rejects content that does not match the extension", async () => {
    await writeFile(join(workspace, "fake.png"), "not an image");
    await expect(readEvidenceFile(workspace, "fake.png")).rejects.toThrow("Evidence file content is not image/png");
  });

  it("rejects empty and oversized files", async () => {
    await writeFile(join(workspace, "empty.png"), "");
    await expect(readEvidenceFile(workspace, "empty.png")).rejects.toThrow("Evidence file is empty");

    await writeFile(join(workspace, "huge.webm"), WEBM_BYTES);
    await truncate(join(workspace, "huge.webm"), MAX_EVIDENCE_BYTES + 1);
    await expect(readEvidenceFile(workspace, "huge.webm")).rejects.toThrow(`the limit is ${MAX_EVIDENCE_BYTES} bytes`);
  });

  it("rejects files outside the workspace, including through a symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "bear-metal-outside-"));
    await writeFile(join(outside, "secret.png"), PNG_BYTES);
    await symlink(join(outside, "secret.png"), join(workspace, "link.png"));

    await expect(readEvidenceFile(workspace, join(outside, "secret.png"))).rejects.toThrow("Path is outside workspace");
    await expect(readEvidenceFile(workspace, "link.png")).rejects.toThrow("Path is outside workspace");
  });
});
