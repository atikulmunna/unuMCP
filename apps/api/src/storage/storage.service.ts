import { Injectable } from "@nestjs/common";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

/**
 * Minimal local-filesystem storage (SRS §8.2: local for MVP, S3 later).
 * Abstracted behind this service so the backing store can change without
 * touching callers.
 */
@Injectable()
export class StorageService {
  private readonly base = process.env.STORAGE_DIR ?? join(tmpdir(), "unumcp-storage");

  async save(relativePath: string, content: string | Buffer): Promise<string> {
    const full = this.contain(relativePath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
    return full;
  }

  async read(pathInStore: string): Promise<string> {
    return readFile(this.contain(pathInStore), "utf8");
  }

  /**
   * Resolve a path against the storage root and refuse anything that escapes it
   * (path-traversal defence, NFR-001/§18.4). Accepts either a relative path or
   * an absolute path that is already inside the root (as returned by `save`).
   */
  private contain(target: string): string {
    const root = resolve(this.base);
    const full = resolve(root, target);
    if (full !== root && !full.startsWith(root + sep)) {
      throw new Error("Refusing to access a path outside the storage root.");
    }
    return full;
  }
}
