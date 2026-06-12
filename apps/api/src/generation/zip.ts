import JSZip from "jszip";

export interface PackagedFile {
  path: string;
  content: string;
}

// A fixed epoch so the archive bytes depend only on file contents (FR-027, §9.7.0).
const FIXED_DATE = new Date(0);

/**
 * Pack files into a deterministic ZIP: entries are sorted by path, stamped with
 * a fixed date, and stored uncompressed, so the same files always produce the
 * same bytes. Pure — no filesystem access.
 */
export async function createZip(files: PackagedFile[]): Promise<Buffer> {
  const zip = new JSZip();
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sorted) {
    zip.file(file.path, file.content, { date: FIXED_DATE });
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
}
