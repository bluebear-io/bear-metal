import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TicketAttachment } from "../shared/integrations/linear/types.js";

export interface DownloadedTicketAttachment {
  title: string;
  path: string;
  size: number;
}

export async function downloadTicketAttachments(
  attachments: TicketAttachment[],
  evidenceDir: string,
  accessToken?: string,
): Promise<DownloadedTicketAttachment[]> {
  await mkdir(evidenceDir, { recursive: true });
  const downloaded: DownloadedTicketAttachment[] = [];

  for (const [index, attachment] of attachments.entries()) {
    const response = await fetch(
      attachment.url,
      accessToken
        ? { headers: { Authorization: `Bearer ${accessToken}` } }
        : undefined,
    );
    if (!response.ok) {
      throw new Error(`Failed to download Linear attachment ${attachment.title}: HTTP ${response.status}`);
    }
    const data = new Uint8Array(await response.arrayBuffer());
    const expectedSize = response.headers.get("content-length");
    if (expectedSize !== null && Number(expectedSize) !== data.byteLength) {
      throw new Error(
        `Linear attachment size mismatch for ${attachment.title}: expected ${expectedSize}, received ${data.byteLength}`,
      );
    }

    const safeTitle = attachment.title.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = join(evidenceDir, `${String(index + 1).padStart(3, "0")}-${safeTitle}`);
    await writeFile(path, data);
    downloaded.push({ title: attachment.title, path, size: data.byteLength });
  }

  return downloaded;
}
