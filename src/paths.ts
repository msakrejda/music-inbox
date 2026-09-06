import path from 'node:path';
import type { FileOp, TrackMeta } from './types.js';

const MAX_SEGMENT_BYTES = 200;

export const UNKNOWN_ARTIST = 'Unknown Artist';
export const UNKNOWN_ALBUM = 'Unknown Album';
export const UNTITLED = 'Untitled';

/**
 * Make one path component safe to write to disk without mangling it beyond
 * recognition. Separators become a dash so "AC/DC" files as "AC-DC" rather
 * than "ACDC"; control characters just vanish.
 */
export function sanitizeSegment(raw: string, fallback: string): string {
  let s = raw.normalize('NFC');
  s = s.replace(/[\u0000-\u001F\u007F]/g, '');
  s = s.replace(/[/\\]/g, '-');
  s = s.replace(/\s+/g, ' ').trim();
  // Trailing dots and spaces are legal on ext4 but break on the FAT/NTFS
  // volumes these libraries often get copied to.
  s = s.replace(/[. ]+$/, '');
  if (s === '' || s === '.' || s === '..') return fallback;
  return truncateBytes(s, MAX_SEGMENT_BYTES) || fallback;
}

function truncateBytes(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  // Trim by code point so a multi-byte character is never split in half.
  let out = '';
  for (const ch of s) {
    if (Buffer.byteLength(out + ch) > max) break;
    out += ch;
  }
  return out.replace(/[. ]+$/, '');
}

/** Directory an album's files live in, relative to the target. */
export function albumDir(track: Pick<TrackMeta, 'albumArtist' | 'album'>): string {
  return path.join(
    sanitizeSegment(track.albumArtist, UNKNOWN_ARTIST),
    sanitizeSegment(track.album, UNKNOWN_ALBUM),
  );
}

/**
 * Output track number for each track, in the order given.
 *
 * A multi-disc album is flattened into one continuous run: disc 2 picks up
 * where disc 1 stopped, so the album needs only one directory and no disc
 * subdirectories. The offset is the highest track number on the preceding
 * discs rather than a count of them, so a disc that is missing a track keeps
 * the same gap it had.
 */
export function outputTrackNumbers(tracks: readonly TrackMeta[]): number[] {
  const highest = new Map<number, number>();
  for (const t of tracks) {
    highest.set(t.disc, Math.max(highest.get(t.disc) ?? 0, trackOf(t)));
  }

  const offsets = new Map<number, number>();
  let running = 0;
  for (const disc of [...highest.keys()].sort((a, b) => a - b)) {
    offsets.set(disc, running);
    running += highest.get(disc) ?? 0;
  }

  return tracks.map((t) => (offsets.get(t.disc) ?? 0) + trackOf(t));
}

function trackOf(track: TrackMeta): number {
  return Math.max(0, Math.trunc(track.track));
}

/** Zero-padded track number. */
export function trackLabel(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

export function isMultiDisc(tracks: readonly TrackMeta[]): boolean {
  return new Set(tracks.map((t) => t.disc)).size > 1;
}

export function trackNumberWidth(numbers: readonly number[]): number {
  const highest = numbers.reduce((max, n) => Math.max(max, n), 0);
  return Math.max(2, String(highest).length);
}

/**
 * Longest directory prefix shared by every entry, e.g. "Geogaddi/" for an
 * archive that wraps everything in one folder. Stripping it keeps that folder
 * from being recreated inside the album directory.
 */
export function commonRoot(entries: readonly string[]): string {
  const first = entries[0]?.split('/');
  if (!first) return '';
  const split = entries.map((p) => p.split('/'));
  let depth = 0;
  while (depth < first.length - 1) {
    const seg = first[depth];
    // Every entry must have this segment as a *directory*, not as its filename.
    if (!split.every((parts) => parts.length > depth + 1 && parts[depth] === seg)) break;
    depth++;
  }
  return depth === 0 ? '' : `${first.slice(0, depth).join('/')}/`;
}

export interface BuildOpsInput {
  tracks: readonly TrackMeta[];
  /** Non-MP3 entries, as paths relative to the archive root. */
  extras: readonly string[];
  /** Absolute path of the temporary extraction directory. */
  root: string;
  /** Directory prefix to strip from extras, from {@link commonRoot}. */
  prefix: string;
}

export function buildOps({ tracks, extras, root, prefix }: BuildOpsInput): FileOp[] {
  const numbers = outputTrackNumbers(tracks);
  const width = trackNumberWidth(numbers);
  const ops: FileOp[] = tracks.map((t, i) => ({
    from: path.join(root, t.source),
    to: path.join(
      albumDir(t),
      `${trackLabel(numbers[i] ?? 0, width)}-${sanitizeSegment(t.title, UNTITLED)}.mp3`,
    ),
    kind: 'track',
  }));

  // Extras belong with the album, so they follow whichever album the bulk of
  // the tracks were filed under.
  const home = tracks.length > 0 ? albumDir(dominantAlbum(tracks)) : '';
  for (const extra of extras) {
    const rel = extra.startsWith(prefix) ? extra.slice(prefix.length) : extra;
    if (rel === '') continue;
    const parts = rel
      .split('/')
      .map((seg, i, all) => sanitizeSegment(seg, i === all.length - 1 ? 'file' : 'files'));
    ops.push({ from: path.join(root, extra), to: path.join(home, ...parts), kind: 'extra' });
  }
  return ops;
}

function dominantAlbum(tracks: readonly TrackMeta[]): Pick<TrackMeta, 'albumArtist' | 'album'> {
  const counts = new Map<string, { key: Pick<TrackMeta, 'albumArtist' | 'album'>; n: number }>();
  for (const t of tracks) {
    // NUL cannot appear in a tag value, so it is a safe key separator.
    const id = `${t.albumArtist}\u0000${t.album}`;
    const hit = counts.get(id);
    if (hit) hit.n++;
    else counts.set(id, { key: { albumArtist: t.albumArtist, album: t.album }, n: 1 });
  }
  let best = { key: { albumArtist: UNKNOWN_ARTIST, album: UNKNOWN_ALBUM }, n: 0 };
  for (const entry of counts.values()) if (entry.n > best.n) best = entry;
  return best.key;
}

/** Destinations claimed by more than one source file. */
export function findCollisions(ops: readonly FileOp[]): string[] {
  const byDest = new Map<string, string[]>();
  for (const op of ops) {
    const sources = byDest.get(op.to);
    if (sources) sources.push(op.from);
    else byDest.set(op.to, [op.from]);
  }
  const messages: string[] = [];
  for (const [dest, sources] of byDest) {
    if (sources.length > 1) {
      messages.push(`${dest} <- ${sources.map((s) => path.basename(s)).join(', ')}`);
    }
  }
  return messages;
}
