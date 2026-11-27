import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deferInterrupts, interrupt, withTempDir } from './cleanup.js';
import { withStdinReleased } from './session.js';
import type { TrackMeta } from './types.js';

export interface ParseResult {
  tracks: TrackMeta[];
  /** Source paths whose row the user deleted. */
  skipped: string[];
  errors: string[];
}

/** The columns a user may change, in display order. */
export function editableColumns(hasDisc: boolean): string[] {
  return hasDisc
    ? ['AlbumArtist', 'Album', 'Disc', 'Track', 'Artist', 'Title']
    : ['AlbumArtist', 'Album', 'Track', 'Artist', 'Title'];
}

/** One track as display cells, in the same order as {@link editableColumns}. */
export function editableCells(track: TrackMeta, hasDisc: boolean): string[] {
  const cells = [track.albumArtist, track.album];
  if (hasDisc) cells.push(String(track.disc));
  cells.push(String(track.track), track.artist, track.title);
  return cells;
}

/**
 * Columns of the editor table. Rows are matched back by `Id`, their 1-based
 * position in the list as rendered. The source path is deliberately not in the
 * table: as the matching key, a find-and-replace over the whole file rejected
 * every row, because archive filenames usually repeat the album and title text
 * being corrected.
 */
export function columnNames(hasDisc: boolean): string[] {
  return ['Id', ...editableColumns(hasDisc)];
}

function header(hasDisc: boolean): string {
  return [
    '# music-inbox: correct anything that is wrong, then save and exit.',
    '# Columns are tab-separated. Lines starting with # are ignored.',
    '#',
    '# Id ties each row to its file: leave it alone. Rows can be reordered.',
    '# Delete a whole line to skip that track and leave it out of the library.',
    '#',
    `# ${columnNames(hasDisc).join('\t')}`,
    '',
  ].join('\n');
}

export function renderTsv(tracks: readonly TrackMeta[], hasDisc: boolean): string {
  const rows = tracks.map((t, i) =>
    [String(i + 1), ...editableCells(t, hasDisc)]
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
  const expected = columnNames(hasDisc).length;
  const tracks: TrackMeta[] = [];
  const errors: string[] = [];
  const seen = new Set<number>();

  const lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const cells = line.split('\t');
    const lineNo = i + 1;

    if (cells.length !== expected) {
      errors.push(`line ${lineNo}: expected ${expected} tab-separated columns, found ${cells.length}`);
      continue;
    }
    const idText = cells[0]!.trim();
    const id = /^\d+$/.test(idText) ? Number(idText) : NaN;
    const base = original[id - 1];
    if (!base) {
      errors.push(
        `line ${lineNo}: "${idText}" is not an Id from this list (the Id column must not be edited)`,
      );
      continue;
    }
    if (seen.has(id)) {
      errors.push(`line ${lineNo}: Id ${id} appears more than once`);
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

    seen.add(id);
    tracks.push({
      source: base.source,
      albumArtist: cells[1]!.trim(),
      album: cells[2]!.trim(),
      disc,
      track,
      artist: cells[cursor++]!.trim(),
      title: cells[cursor]!.trim(),
    });
  }

  const skipped = original.filter((_, i) => !seen.has(i + 1)).map((t) => t.source);
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
  const { code, signal } = await withStdinReleased(() =>
    deferInterrupts(
      () =>
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
          const child = spawn('sh', ['-c', `${command} "$1"`, 'sh', file], { stdio: 'inherit' });
          child.on('error', reject);
          child.on('close', (code, signal) => resolve({ code, signal }));
        }),
    ),
  );
  // The editor did not catch Ctrl-C and died of it (130 when sh reports it):
  // the user meant to stop the run, not to fail this archive and carry on.
  if (signal === 'SIGINT' || code === 130) interrupt('SIGINT');
  if (code !== 0) {
    throw new Error(`${command} exited with ${signal ? `signal ${signal}` : `status ${code}`}`);
  }
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
  return withTempDir('music-inbox-edit-', async (dir) => {
    const file = path.join(dir, 'tracks.tsv');
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
  });
}

function stripComplaints(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.startsWith('# !!') && !line.startsWith('# Could not read'))
    .join('\n');
}
