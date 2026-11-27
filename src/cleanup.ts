import { rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Temp dirs currently in use. `finally` blocks do not run when a signal ends
 * the process, so anything here is swept synchronously on the way out instead.
 */
const live = new Set<string>();
let installed = false;
/** While > 0, Ctrl-C belongs to a child (the editor), not to us. */
let deferred = 0;

const HANDLED = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
type Handled = (typeof HANDLED)[number];

function sweep(): void {
  for (const dir of live) {
    try {
      // Synchronous on purpose: an async rm would not finish before exit.
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort; the OS will reap the temp dir eventually.
    }
  }
  live.clear();
}

/** Remove every live temp dir and exit as if killed by `signal`. */
export function interrupt(signal: Handled = 'SIGINT'): never {
  sweep();
  process.exit(128 + os.constants.signals[signal]);
}

function install(): void {
  if (installed) return;
  installed = true;
  process.on('exit', sweep);
  for (const signal of HANDLED) {
    process.on(signal, () => {
      if (signal === 'SIGINT' && deferred > 0) return;
      interrupt(signal);
    });
  }
}

/** Run `fn` with a fresh temp directory, removed however `fn` finishes. */
export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  install();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  live.add(dir);
  try {
    return await fn(dir);
  } finally {
    live.delete(dir);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Let a child that shares our terminal handle Ctrl-C itself, as git does for
 * $EDITOR. The terminal delivers SIGINT to the whole foreground process group,
 * and an editor that catches it (vim, emacs) should not have the run torn down
 * underneath it. If the child dies of it instead, the caller should
 * {@link interrupt}.
 */
export async function deferInterrupts<T>(fn: () => Promise<T>): Promise<T> {
  install();
  deferred++;
  try {
    return await fn();
  } finally {
    deferred--;
  }
}
