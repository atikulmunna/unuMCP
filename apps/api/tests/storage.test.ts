import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageService } from "../src/storage/storage.service";

// P6-9 / §18.4: path traversal in generated filenames must not escape the store.
let root: string;
let storage: StorageService;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "unumcp-store-test-"));
  process.env.STORAGE_DIR = root;
  storage = new StorageService();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  delete process.env.STORAGE_DIR;
});

describe("StorageService path containment", () => {
  it("writes and reads a normal nested path", async () => {
    const full = await storage.save("proj/generated/run/src/index.ts", "hello");
    expect(full.startsWith(root)).toBe(true);
    expect(await readFile(full, "utf8")).toBe("hello");
    expect(await storage.read(full)).toBe("hello");
  });

  it("refuses a relative path that escapes the root", async () => {
    await expect(storage.save("../escape.ts", "x")).rejects.toThrow(/outside the storage root/i);
    await expect(storage.save("proj/../../escape.ts", "x")).rejects.toThrow(/outside the storage root/i);
    await expect(storage.save("../../etc/passwd", "x")).rejects.toThrow(/outside the storage root/i);
  });

  it("refuses reading an absolute path outside the root", async () => {
    const outside = join(tmpdir(), "definitely-not-in-store.txt");
    await expect(storage.read(outside)).rejects.toThrow(/outside the storage root/i);
  });
});
