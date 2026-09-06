import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withStdinReleased } from './session.js';
import type { TrackMeta } from './types.js';

export interface ParseResult {
  tracks: TrackMeta[];
  /** Source paths whose row the user deleted. */
  skipped: string[];
  errors: string[];
}

export function columnNames(hasDisc: boolean): string[] {
  return hasDisc
    ? ['SourceFile', 'AlbumArtist', 'Album', 'Disc', 'Track', 'Artist', 'Title']
    : ['SourceFile', 'AlbumArtist', 'Album', 'Track', 'Artist', 'Title'];
}

/** One track as display cells, in the same order as {@link columnNames}. */
export function trackCells(track: TrackMeta, hasDisc: boolean): string[] {
  const cells = [track.source, track.albumArtist, track.album];
  if (hasDisc) cells.push(String(track.disc));
  cells.push(String(track.track), track.artist, track.title);
  return cells;
}

function header(hasDisc: boolean): string {
  return [
    '# music-inbox: correct anything that is wrong, then save and exit.',
    '# Columns are tab-separated. Lines starting with # are ignored.',
    '#',
    '# The first column is the file inside the archive. Leave it alone: it is how',
    '# your edits are matched back to the files. Delete a whole line to skip that',
    '# track and leave it out of the library.',
    '#',
    `# ${columnNames(hasDisc).join('\t')}`,
    '',
  ].join('\n');
}

export function renderTsv(tracks: readonly TrackMeta[], hasDisc: boolean): string {
  const rows = tracks.map((t) =>
    trackCells(t, hasDisc)
      // A stray tab inside a value would silently add a column.
      .map((cell) => cell.replace(/\t/g, ' '))
      .join('\t'),
  );
  return `${header(hasDisc)}${rows.join('\n')}\n`;
}

export function parseTsv(
  text: string,
  original: readonly TrackMeta[],
  hasDisc: boolean,
): ParseResult {
  const bySource = new Map(original.map((t) => [t.source, t]));
  const expected = columnNames(hasDisc).length;
  const tracks: TrackMeta[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  const lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const cells = line.split('\t');
    const lineNo = i + 1;

    if (cells.length !== expected) {
      errors.push(`line ${lineNo}: expected ${expected} tab-separated columns, found ${cells.length}`);
      continue;
    }
    const source = cells[0]!.trim();
    const base = bySource.get(source);
    if (!base) {
      errors.push(`line ${lineNo}: "${source}" is not a file in this archive (column 1 must not be edited)`);
      continue;
    }
    if (seen.has(source)) {
      errors.push(`line ${lineNo}: "${source}" appears more than once`);
      continue;
    }

    let cursor = 3;
    const disc = hasDisc ? Number(cells[cursor++]!.trim()) : base.disc;
    const track = Number(cells[cursor++]!.trim());
    if (!Number.isInteger(disc) || disc < 1) {
      errors.push(`line ${lineNo}: disc must be a whole number of 1 or more`);
      continue;
    }
    if (!Number.isInteger(track) || track < 0) {
      errors.push(`line ${lineNo}: track must be a whole number of 0 or more`);
      continue;
    }

    seen.add(source);
    tracks.push({
      source,
      albumArtist: cells[1]!.trim(),
      album: cells[2]!.trim(),
      disc,
      track,
      artist: cells[cursor++]!.trim(),
      title: cells[cursor]!.trim(),
    });
  }

  const skipped = original.map((t) => t.source).filter((s) => !seen.has(s));
  return { tracks, skipped, errors };
}

function editorCommand(): string {
  return process.env['VISUAL'] || process.env['EDITOR'] || 'vi';
}

/**
 * Open `file` in the user's editor and wait. Goes through `sh -c` because
 * $EDITOR routinely carries arguments ("emacs -nw", "code --wait") and would
 * not resolve as a bare executable name.
 */
export async function openInEditor(file: string): Promise<void> {
  const command = editorCommand();
  await withStdinReleased(
    () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn('sh', ['-c', `${command} "$1"`, 'sh', file], { stdio: 'inherit' });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`${command} exited with status ${code ?? 'unknown'}`));
        });
      }),
  );
}

/**
 * Round-trip the track list through $EDITOR. Parse failures re-open the same
 * file with the problems listed at the top, so a typo never costs the user
 * the rest of their edits.
 */
export async function reviewInEditor(
  tracks: readonly TrackMeta[],
  hasDisc: boolean,
): Promise<ParseResult> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'music-inbox-edit-'));
  const file = path.join(dir, 'tracks.tsv');
  try {
    let body = renderTsv(tracks, hasDisc);
    for (;;) {
      await fs.writeFile(file, body, 'utf8');
      await openInEditor(file);
      const edited = await fs.readFile(file, 'utf8');
      const result = parseTsv(edited, tracks, hasDisc);
      if (result.errors.length === 0) return result;
      const complaints = result.errors.map((e) => `# !! ${e}`).join('\n');
      body = `# Could not read your edits. Fix these and save again:\n${complaints}\n#\n${stripComplaints(edited)}`;
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function stripComplaints(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.startsWith('# !!') && !line.startsWith('# Could not read'))
    .join('\n');
}
