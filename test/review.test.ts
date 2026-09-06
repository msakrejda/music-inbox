import assert from 'node:assert/strict';
import test from 'node:test';
import { columnNames, parseTsv, renderTsv, trackCells } from '../src/review.js';
import type { TrackMeta } from '../src/types.js';

const tracks: TrackMeta[] = [
  {
    source: 'Geogaddi/01.mp3',
    albumArtist: 'Boards of Canada',
    album: 'Geogaddi',
    artist: 'Boards of Canada',
    title: 'Ready Lets Go',
    track: 1,
    disc: 1,
  },
  {
    source: 'Geogaddi/02.mp3',
    albumArtist: 'Boards of Canada',
    album: 'Geogaddi',
    artist: 'Boards of Canada',
    title: 'Music Is Math',
    track: 2,
    disc: 1,
  },
];

test('the disc column only appears for multi-disc albums', () => {
  assert.deepEqual(columnNames(false), [
    'SourceFile',
    'AlbumArtist',
    'Album',
    'Track',
    'Artist',
    'Title',
  ]);
  assert.equal(columnNames(true).length, 7);
  assert.equal(trackCells(tracks[0]!, true)[3], '1');
});

test('render then parse round-trips unchanged', () => {
  const result = parseTsv(renderTsv(tracks, false), tracks, false);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.tracks, tracks);
});

test('round-trip preserves the disc when the column is shown', () => {
  const multi = [tracks[0]!, { ...tracks[1]!, disc: 2 }];
  const result = parseTsv(renderTsv(multi, true), multi, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.tracks, multi);
});

test('edits are applied', () => {
  const edited = renderTsv(tracks, false).replace('Music Is Math', 'Music is Math');
  const result = parseTsv(edited, tracks, false);
  assert.deepEqual(result.errors, []);
  assert.equal(result.tracks[1]?.title, 'Music is Math');
});

test('rows are matched by source path, not by position', () => {
  const lines = renderTsv(tracks, false).trimEnd().split('\n');
  const body = lines.filter((l) => !l.startsWith('#') && l !== '');
  const comments = lines.filter((l) => l.startsWith('#'));
  const reordered = [...comments, ...body.reverse()].join('\n');

  const result = parseTsv(reordered, tracks, false);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.tracks.map((t) => t.source),
    ['Geogaddi/02.mp3', 'Geogaddi/01.mp3'],
  );
});

test('a deleted row is reported as skipped, not lost silently', () => {
  const kept = renderTsv(tracks, false)
    .split('\n')
    .filter((l) => !l.includes('Geogaddi/02.mp3'))
    .join('\n');
  const result = parseTsv(kept, tracks, false);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.skipped, ['Geogaddi/02.mp3']);
  assert.equal(result.tracks.length, 1);
});

test('a row with the wrong number of columns is an error', () => {
  const broken = `${renderTsv(tracks, false)}Geogaddi/01.mp3\tonly two\n`;
  const result = parseTsv(broken, tracks, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0] ?? '', /expected 6 tab-separated columns, found 2/);
});

test('an edited source path is rejected rather than guessed at', () => {
  const broken = renderTsv(tracks, false).replace('Geogaddi/01.mp3', 'Geogaddi/99.mp3');
  const result = parseTsv(broken, tracks, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0] ?? '', /is not a file in this archive/);
});

test('a non-numeric track number is an error', () => {
  const broken = renderTsv(tracks, false).replace(
    'Geogaddi\t1\tBoards of Canada\tReady Lets Go',
    'Geogaddi\tone\tBoards of Canada\tReady Lets Go',
  );
  const result = parseTsv(broken, tracks, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0] ?? '', /track must be a whole number/);
});

test('a duplicated row is rejected', () => {
  const body = renderTsv(tracks, false);
  const dup = `${body}${body.trimEnd().split('\n').at(-1)}\n`;
  const result = parseTsv(dup, tracks, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0] ?? '', /appears more than once/);
});

test('a tab inside a value cannot smuggle in an extra column', () => {
  const nasty: TrackMeta[] = [{ ...tracks[0]!, title: 'Ready\tLets\tGo' }];
  const result = parseTsv(renderTsv(nasty, false), nasty, false);
  assert.deepEqual(result.errors, []);
  assert.equal(result.tracks[0]?.title, 'Ready Lets Go');
});

test('comments and blank lines are ignored', () => {
  const text = `# a comment\n\n${renderTsv(tracks, false)}\n# trailing\n`;
  const result = parseTsv(text, tracks, false);
  assert.deepEqual(result.errors, []);
  assert.equal(result.tracks.length, 2);
});
