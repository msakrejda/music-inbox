import { constants, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FileOp } from './types.js';

/** Temp dirs currently in use, so a Ctrl-C does not strand extracted albums. */
const live = new Set<string>();
let cleanupInstalled = false;

function installCleanup(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  const sweep = () => {
    for (const dir of live) {
      try {
        // Synchronous on purpose: an async unlink would not finish before exit.
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort; the OS will reap /tmp eventually.
      }
    }
  };
  process.on('exit', sweep);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      sweep();
      process.exit(130);
    });
  }
}

/** Run `fn` with a fresh temp directory, removed however `fn` finishes. */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  installCleanup();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'music-inbox-'));
  live.add(dir);
  try {
    return await fn(dir);
  } finally {
    live.delete(dir);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

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
