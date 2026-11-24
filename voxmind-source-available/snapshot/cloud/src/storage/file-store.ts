import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import type { ObjectStore, StoredObject } from "./object-store.js";

export class FileObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private pathFor(key: string) {
    const safe = normalize(key).replace(/^(\.\.(\/|\\|$))+/, "");
    const path = join(this.root, safe);
    if (!path.startsWith(normalize(this.root))) throw new Error("非法对象路径");
    return path;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    const finalPath = this.pathFor(key);
    const tempPath = `${finalPath}.${process.pid}.${Date.now()}.part`;
    await mkdir(dirname(finalPath), { recursive: true });
    const file = await open(tempPath, "wx");
    try {
      await file.writeFile(body);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tempPath, finalPath);
    return { key, byteLength: body.byteLength, contentType };
  }

  async get(key: string) {
    try {
      return { body: await readFile(this.pathFor(key)), contentType: contentTypeFor(key) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(key: string) { await rm(this.pathFor(key), { force: true }); }
}

function contentTypeFor(key: string) {
  if (key.endsWith(".opus")) return "audio/opus";
  if (key.endsWith(".ogg")) return "audio/ogg";
  if (key.endsWith(".wav")) return "audio/wav";
  return "application/octet-stream";
}

