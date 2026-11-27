import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileOp } from './types.js';

/** Destinations that already exist on disk, relative to `target`. */
export async function findExisting(ops: readonly FileOp[], target: string): Promise<string[]> {
  const hits = await Promise.all(
    ops.map(async (op) => {
      try {
        await fs.access(path.join(target, op.to));
        return op.to;
      } catch {
        return undefined;
      }
    }),
  );
  return hits.filter((h) => h !== undefined);
}

/**
 * Perform the copies. Copy rather than rename: the temp dir is under
 * os.tmpdir() and the library usually is not, so rename would fail with EXDEV
 * across filesystems. COPYFILE_EXCL is a last line of defence -- collisions
 * are meant to have been caught before we get here.
 */
export async function executeOps(ops: readonly FileOp[], target: string): Promise<string[]> {
  const created: string[] = [];
  for (const op of ops) {
    const dest = path.join(target, op.to);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(op.from, dest, constants.COPYFILE_EXCL);
    created.push(op.to);
  }
  return created;
}
