import type { Provider } from '@nestjs/common';
import { ENV } from '../env.provider.js';
import type { Env } from '../env.js';
import type { ChunkStorage } from './chunk-storage.js';
import { LocalFsChunkStorage } from './local-fs-chunk-storage.js';

export const CHUNK_STORAGE = Symbol('CHUNK_STORAGE');

export const chunkStorageProvider: Provider = {
  provide: CHUNK_STORAGE,
  useFactory: (env: Env): ChunkStorage => new LocalFsChunkStorage(env.ATTACHMENTS_STORAGE_DIR),
  inject: [ENV],
};
