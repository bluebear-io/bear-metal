import { open, realpath } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { resolveExistingPathInWorkspace } from "./workspace-guard.js";

/** Bear Metal's own cap; Linear may reject smaller files, and that error is surfaced unchanged. */
export const MAX_EVIDENCE_BYTES = 50 * 1024 * 1024;

interface EvidenceType {
  contentType: string;
  matches(head: Uint8Array): boolean;
}

const startsWith = (head: Uint8Array, bytes: readonly number[], offset = 0) =>
  bytes.every((byte, index) => head[offset + index] === byte);

const PNG: EvidenceType = { contentType: "image/png", matches: (h) => startsWith(h, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) };
const JPEG: EvidenceType = { contentType: "image/jpeg", matches: (h) => startsWith(h, [0xff, 0xd8, 0xff]) };
// WebM is an EBML container; MP4 has an `ftyp` box at byte 4.
const WEBM: EvidenceType = { contentType: "video/webm", matches: (h) => startsWith(h, [0x1a, 0x45, 0xdf, 0xa3]) };
const MP4: EvidenceType = { contentType: "video/mp4", matches: (h) => startsWith(h, [0x66, 0x74, 0x79, 0x70], 4) };

export const EVIDENCE_TYPES: Readonly<Record<string, EvidenceType>> = {
  ".png": PNG,
  ".jpg": JPEG,
  ".jpeg": JPEG,
  ".webm": WEBM,
  ".mp4": MP4,
};

export interface EvidenceFile {
  filename: string;
  contentType: string;
  data: Uint8Array;
}

/** Reads a screenshot or video from the workspace, rejecting anything that is not a supported, non-empty, in-limit media file. */
export async function readEvidenceFile(workspaceRoot: string, path: string): Promise<EvidenceFile> {
  const extension = extname(path).toLowerCase();
  const type = EVIDENCE_TYPES[extension];
  if (!type) {
    throw new Error(`Unsupported evidence file type "${extension || basename(path)}"; allowed: ${Object.keys(EVIDENCE_TYPES).join(", ")}`);
  }
  const root = await realpath(workspaceRoot);
  const target = await resolveExistingPathInWorkspace(root, resolve(root, path));
  const handle = await open(target, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`Evidence path is not a regular file: ${path}`);
    if (stats.size === 0) throw new Error(`Evidence file is empty: ${path}`);
    if (stats.size > MAX_EVIDENCE_BYTES) {
      throw new Error(`Evidence file is ${stats.size} bytes; the limit is ${MAX_EVIDENCE_BYTES} bytes: ${path}`);
    }
    const data = new Uint8Array(await handle.readFile());
    if (data.byteLength !== stats.size) throw new Error(`Evidence file changed while reading: ${path}`);
    if (!type.matches(data)) throw new Error(`Evidence file content is not ${type.contentType}: ${path}`);
    return { filename: basename(target), contentType: type.contentType, data };
  } finally {
    await handle.close();
  }
}
