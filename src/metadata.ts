import path from 'node:path';
import { parseFile } from 'music-metadata';
import type { ICommonTagsResult } from 'music-metadata';
import { UNKNOWN_ARTIST, UNTITLED } from './paths.js';
import type { TrackMeta } from './types.js';

export const VARIOUS_ARTISTS = 'Various Artists';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Sort "track2" before "track10", the way a person would. */
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b);
}

function clean(value: string | undefined): string | undefined {
  const s = value?.trim();
  return s === undefined || s === '' ? undefined : s;
}

/** Most frequent non-empty value; ties go to whichever appeared first. */
function majority(values: readonly (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (v === undefined) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [value, n] of counts) {
    if (n > bestCount) {
      best = value;
      bestCount = n;
    }
  }
  return best;
}

/** "03 - Sunshine Recorder.mp3" -> "Sunshine Recorder" */
export function titleFromFilename(rel: string): string {
  const base = path.posix.basename(rel).replace(/\.[^.]+$/, '');
  return base.replace(/^\s*\d{1,3}(?:\s*[-._)\]]+\s*|\s+)/, '').trim() || base.trim();
}

/** Leading track number in a filename, if it has one. */
export function trackFromFilename(rel: string): number | undefined {
  const m = /^\s*(\d{1,3})\b/.exec(path.posix.basename(rel));
  if (!m?.[1]) return undefined;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function readCommon(file: string): Promise<ICommonTagsResult | undefined> {
  try {
    const { common } = await parseFile(file, { duration: false, skipCovers: true });
    return common;
  } catch {
    // An unreadable or untagged file is normal, not fatal: fall back to
    // whatever the filename tells us.
    return undefined;
  }
}

/**
 * Read metadata for every MP3 in an archive and fill the gaps. Album-level
 * fields are decided once for the whole archive by majority vote, so a single
 * mistagged file cannot split an album across two directories.
 */
export async function readTracks(
  root: string,
  files: readonly string[],
  archivePath: string,
): Promise<TrackMeta[]> {
  const sorted = [...files].sort(naturalCompare);
  const raw = await Promise.all(
    sorted.map(async (rel) => ({ rel, common: await readCommon(path.join(root, rel)) })),
  );

  const album =
    majority(raw.map((r) => clean(r.common?.album))) ??
    path.basename(archivePath, path.extname(archivePath));

  const artists = new Set(raw.map((r) => clean(r.common?.artist)).filter((a) => a !== undefined));
  const albumArtist =
    majority(raw.map((r) => clean(r.common?.albumartist))) ??
    (artists.size === 1 ? [...artists][0]! : artists.size > 1 ? VARIOUS_ARTISTS : UNKNOWN_ARTIST);

  return raw.map(({ rel, common }, i) => ({
    source: rel,
    albumArtist,
    album,
    artist: clean(common?.artist) ?? albumArtist,
    title: clean(common?.title) ?? titleFromFilename(rel) ?? UNTITLED,
    track: common?.track?.no ?? trackFromFilename(rel) ?? i + 1,
    disc: common?.disk?.no ?? 1,
  }));
}
