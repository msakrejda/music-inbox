import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';

/** Archive members that are packaging noise rather than album content. */
function isJunk(name: string): boolean {
  const base = path.posix.basename(name);
  return (
    name.startsWith('__MACOSX/') ||
    name.includes('/__MACOSX/') ||
    base === '.DS_Store' ||
    base === 'Thumbs.db' ||
    base.startsWith('._')
  );
}

/**
 * Reject anything that would escape the extraction directory: absolute paths,
 * Windows drive letters, and `..` traversal (the "zip slip" family). Returns
 * null for entries that should simply be skipped.
 */
export function safeEntryName(fileName: string): string | null {
  const name = fileName.replace(/\\/g, '/');
  if (name === '' || name.endsWith('/')) return null; // directory entry
  if (isJunk(name)) return null;
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return null;
  const parts = name.split('/');
  if (parts.some((p) => p === '..' || p === '.' || p === '')) return null;
  return parts.join('/');
}

/** Unix mode bits live in the high half of the external attributes. */
function isSymlink(entry: Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
  return mode === 0xa000;
}

function openZip(zipPath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) reject(err);
      else if (!zipfile) reject(new Error(`could not open ${zipPath}`));
      else resolve(zipfile);
    });
  });
}

function openEntryStream(zipfile: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err) reject(err);
      else if (!stream) reject(new Error(`could not read ${entry.fileName}`));
      else resolve(stream);
    });
  });
}

async function writeEntry(
  zipfile: ZipFile,
  entry: Entry,
  destDir: string,
  written: string[],
): Promise<void> {
  const rel = safeEntryName(entry.fileName);
  if (rel === null || isSymlink(entry)) return;

  const dest = path.join(destDir, rel);
  // Belt and braces: safeEntryName should already guarantee containment.
  const root = path.resolve(destDir);
  if (!path.resolve(dest).startsWith(root + path.sep)) return;

  await fs.mkdir(path.dirname(dest), { recursive: true });
  const stream = await openEntryStream(zipfile, entry);
  await pipeline(stream, createWriteStream(dest));
  written.push(rel);
}

/**
 * Extract every regular file from `zipPath` into `destDir`, streaming rather
 * than buffering so large albums do not sit in memory. Resolves to the
 * extracted paths, relative to `destDir`, in archive order.
 */
export function extractArchive(zipPath: string, destDir: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    openZip(zipPath).then((zipfile) => {
      const written: string[] = [];
      const fail = (err: unknown) => {
        zipfile.close();
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      zipfile.on('entry', (entry: Entry) => {
        writeEntry(zipfile, entry, destDir, written).then(() => zipfile.readEntry(), fail);
      });
      zipfile.on('end', () => resolve(written));
      zipfile.on('error', fail);
      zipfile.readEntry();
    }, reject);
  });
}
