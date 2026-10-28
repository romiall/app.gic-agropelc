/**
 * {@link ChunkStorage} — émulateur local (AV-091) : chaque `key` (`storage_key`, toujours
 * généré par le serveur, jamais fourni par l'appareil) est un fichier sous `baseDir`. Ajout
 * strictement séquentiel (§ du port) : `fs.appendFile` après vérification de la taille
 * actuelle, jamais d'écriture positionnée.
 */
import { createReadStream } from 'node:fs';
import { mkdir, appendFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, normalize, relative } from 'node:path';
import { ChunkOffsetMismatchError, type ChunkStorage } from './chunk-storage.js';

export class LocalFsChunkStorage implements ChunkStorage {
  constructor(private readonly baseDir: string) {}

  async uploadedBytes(key: string): Promise<number> {
    try {
      const info = await stat(this.pathFor(key));
      return info.size;
    } catch (error) {
      if (isNotFound(error)) return 0;
      throw error;
    }
  }

  async appendChunk(key: string, offset: number, chunk: Buffer): Promise<number> {
    const path = this.pathFor(key);
    const current = await this.uploadedBytes(key);
    if (current !== offset) {
      throw new ChunkOffsetMismatchError(key, current, offset);
    }
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, chunk);
    return current + chunk.length;
  }

  async readAll(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async *readChunks(key: string, chunkSize: number): AsyncIterable<Buffer> {
    const stream = createReadStream(this.pathFor(key), { highWaterMark: chunkSize });
    for await (const chunk of stream) yield chunk as Buffer;
  }

  async listKeys(prefix: string): Promise<readonly string[]> {
    try {
      const entries = await readdir(this.pathFor(prefix), { withFileTypes: true });
      return entries.filter((entry) => entry.isFile()).map((entry) => `${prefix}/${entry.name}`);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  private pathFor(key: string): string {
    const path = normalize(join(this.baseDir, key));
    const rel = relative(this.baseDir, path);
    if (rel.startsWith('..') || rel === '') {
      throw new Error(`Clé de stockage invalide (hors de baseDir) : ${key}.`);
    }
    return path;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
  );
}
