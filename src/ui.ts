import path from 'node:path';
import { styleText } from 'node:util';
import { columnNames, trackCells } from './review.js';
import { prompt } from './session.js';
import type { TrackMeta } from './types.js';

type Style = Parameters<typeof styleText>[0];

// styleText already no-ops when stdout is not a TTY and honours NO_COLOR.
function paint(style: Style, text: string): string {
  return styleText(style, text);
}

export const dim = (s: string) => paint('dim', s);
export const bold = (s: string) => paint('bold', s);
export const warn = (s: string) => paint('yellow', s);
export const error = (s: string) => paint('red', s);

const IMAGE = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff']);
const TEXT = new Set(['.txt', '.nfo', '.log', '.cue', '.md', '.m3u', '.m3u8', '.sfv', '.pdf']);

function styleForFile(rel: string): Style {
  const ext = path.extname(rel).toLowerCase();
  if (ext === '.mp3') return 'cyan';
  if (IMAGE.has(ext)) return 'magenta';
  if (TEXT.has(ext)) return 'green';
  return 'white';
}

/** Left-aligned columns, sized to their contents. */
function renderTable(rows: readonly string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    for (const [i, cell] of row.entries()) {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    }
  }
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd(),
  );
}

export function printTracks(tracks: readonly TrackMeta[], hasDisc: boolean): void {
  // The source path is the matching key for edits, not something worth the
  // screen space here.
  const names = columnNames(hasDisc).slice(1);
  const rows = [names, ...tracks.map((t) => trackCells(t, hasDisc).slice(1))];
  const [head, ...body] = renderTable(rows);
  console.log(bold(head ?? ''));
  for (const line of body) console.log(line);
}

/** List created paths, grouped by directory, coloured by file type. */
export function printCreated(created: readonly string[], target: string): void {
  const byDir = new Map<string, string[]>();
  for (const rel of created) {
    const dir = path.dirname(rel);
    const bucket = byDir.get(dir);
    if (bucket) bucket.push(path.basename(rel));
    else byDir.set(dir, [path.basename(rel)]);
  }
  for (const [dir, files] of [...byDir].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(paint(['bold', 'blue'], `${path.join(target, dir)}${path.sep}`));
    for (const file of files.sort()) {
      console.log(`  ${paint(styleForFile(file), file)}`);
    }
  }
}

export async function confirm(question: string, fallback = false): Promise<boolean> {
  const hint = fallback ? '[Y/n]' : '[y/N]';
  const answer = (await prompt(`${question} ${hint} `)).toLowerCase();
  if (answer === '') return fallback;
  return answer === 'y' || answer === 'yes';
}

export type Action = 'continue' | 'edit' | 'skip' | 'quit';

export async function askAction(): Promise<Action> {
  for (;;) {
    const answer = (await prompt('[c]ontinue, [e]dit, [s]kip, [q]uit? ')).toLowerCase();
    if (answer === '' || answer === 'c' || answer === 'continue') return 'continue';
    if (answer === 'e' || answer === 'edit') return 'edit';
    if (answer === 's' || answer === 'skip') return 'skip';
    if (answer === 'q' || answer === 'quit') return 'quit';
    console.log(warn('Please answer c, e, s or q.'));
  }
}
