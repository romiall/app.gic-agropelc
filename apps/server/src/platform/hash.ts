import { createHash } from 'node:crypto';

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function sha256HexOfBuffer(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
