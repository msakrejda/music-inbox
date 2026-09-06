import assert from 'node:assert/strict';
import test from 'node:test';
import {
  albumDir,
  buildOps,
  commonRoot,
  findCollisions,
  isMultiDisc,
  outputTrackNumbers,
  sanitizeSegment,
  trackLabel,
  trackNumberWidth,
} from '../src/paths.js';
import type { TrackMeta } from '../src/types.js';

function track(over: Partial<TrackMeta> = {}): TrackMeta {
  return {
    source: 'a.mp3',
    albumArtist: 'Boards of Canada',
    album: 'Geogaddi',
    artist: 'Boards of Canada',
    title: 'Music Is Math',
    track: 1,
    disc: 1,
    ...over,
  };
}

test('sanitizeSegment turns separators into dashes rather than dropping them', () => {
  assert.equal(sanitizeSegment('AC/DC', 'x'), 'AC-DC');
  assert.equal(sanitizeSegment('AC\\DC', 'x'), 'AC-DC');
});

test('sanitizeSegment removes control characters', () => {
  assert.equal(sanitizeSegment('Rock\u0000or\u0007Bust', 'x'), 'RockorBust');
});

test('sanitizeSegment collapses whitespace and trims trailing dots', () => {
  assert.equal(sanitizeSegment('  Music   Is  Math . ', 'x'), 'Music Is Math');
});

test('sanitizeSegment falls back for empty and traversal segments', () => {
  assert.equal(sanitizeSegment('', 'Untitled'), 'Untitled');
  assert.equal(sanitizeSegment('   ', 'Untitled'), 'Untitled');
  assert.equal(sanitizeSegment('..', 'Untitled'), 'Untitled');
  assert.equal(sanitizeSegment('.', 'Untitled'), 'Untitled');
});

test('sanitizeSegment truncates to 200 bytes without splitting a character', () => {
  const out = sanitizeSegment('é'.repeat(300), 'x');
  assert.ok(Buffer.byteLength(out) <= 200);
  // NFC normalisation makes these two-byte characters, so none may be halved.
  assert.equal(Buffer.from(out, 'utf8').toString('utf8'), out);
});

test('albumDir nests artist then album', () => {
  assert.equal(albumDir(track()), 'Boards of Canada/Geogaddi');
});

test('trackLabel pads to the requested width', () => {
  assert.equal(trackLabel(3, 2), '03');
  assert.equal(trackLabel(12, 2), '12');
  assert.equal(trackLabel(7, 3), '007');
});

test('trackNumberWidth widens past 99 tracks', () => {
  assert.equal(trackNumberWidth([9]), 2);
  assert.equal(trackNumberWidth([100]), 3);
});

test('a single-disc album keeps the numbering it already has', () => {
  assert.deepEqual(outputTrackNumbers([track({ track: 1 }), track({ track: 2 })]), [1, 2]);
});

test('later discs continue where the previous one stopped', () => {
  assert.deepEqual(
    outputTrackNumbers([
      track({ disc: 1, track: 1 }),
      track({ disc: 1, track: 2 }),
      track({ disc: 1, track: 3 }),
      track({ disc: 2, track: 1 }),
      track({ disc: 2, track: 2 }),
    ]),
    [1, 2, 3, 4, 5],
  );
});

test('a third disc follows the running total', () => {
  assert.deepEqual(
    outputTrackNumbers([
      track({ disc: 1, track: 1 }),
      track({ disc: 2, track: 1 }),
      track({ disc: 2, track: 2 }),
      track({ disc: 3, track: 1 }),
    ]),
    [1, 2, 3, 4],
  );
});

test('a gap inside a disc is carried into the renumbering', () => {
  // Disc 1 ends at 12 even though 11 is missing, so disc 2 starts at 13.
  assert.deepEqual(
    outputTrackNumbers([
      track({ disc: 1, track: 10 }),
      track({ disc: 1, track: 12 }),
      track({ disc: 2, track: 1 }),
    ]),
    [10, 12, 13],
  );
});

test('discs are ordered by number, not by the order the tracks arrive in', () => {
  assert.deepEqual(
    outputTrackNumbers([
      track({ disc: 2, track: 1 }),
      track({ disc: 1, track: 1 }),
      track({ disc: 1, track: 2 }),
    ]),
    [3, 1, 2],
  );
});

test('non-contiguous disc numbers still chain', () => {
  assert.deepEqual(
    outputTrackNumbers([track({ disc: 1, track: 1 }), track({ disc: 3, track: 1 })]),
    [1, 2],
  );
});

test('isMultiDisc only fires when discs actually differ', () => {
  assert.equal(isMultiDisc([track({ disc: 1 }), track({ disc: 1 })]), false);
  assert.equal(isMultiDisc([track({ disc: 1 }), track({ disc: 2 })]), true);
});

test('commonRoot strips a single wrapping folder', () => {
  assert.equal(commonRoot(['Geogaddi/01.mp3', 'Geogaddi/cover.jpg']), 'Geogaddi/');
  assert.equal(commonRoot(['a/b/01.mp3', 'a/b/c/x.jpg']), 'a/b/');
});

test('commonRoot returns nothing when entries do not share a folder', () => {
  assert.equal(commonRoot(['01.mp3', 'cover.jpg']), '');
  assert.equal(commonRoot(['CD1/01.mp3', 'CD2/01.mp3', 'cover.jpg']), '');
  assert.equal(commonRoot([]), '');
});

test('commonRoot stops before the filename', () => {
  // A lone wrapper folder is still a wrapper, but the file itself is never eaten.
  assert.equal(commonRoot(['Album/cover.jpg']), 'Album/');
  assert.equal(commonRoot(['cover.jpg']), '');
});

test('buildOps files tracks and extras into the album directory', () => {
  const ops = buildOps({
    tracks: [
      track({ source: 'Geogaddi/01.mp3', title: 'Ready Lets Go', track: 1 }),
      track({ source: 'Geogaddi/02.mp3', title: 'Music Is Math', track: 2 }),
    ],
    extras: ['Geogaddi/cover.jpg', 'Geogaddi/scans/back.jpg'],
    root: '/tmp/x',
    prefix: 'Geogaddi/',
  });
  assert.deepEqual(
    ops.map((o) => o.to),
    [
      'Boards of Canada/Geogaddi/01-Ready Lets Go.mp3',
      'Boards of Canada/Geogaddi/02-Music Is Math.mp3',
      'Boards of Canada/Geogaddi/cover.jpg',
      'Boards of Canada/Geogaddi/scans/back.jpg',
    ],
  );
  assert.deepEqual(
    ops.map((o) => o.kind),
    ['track', 'track', 'extra', 'extra'],
  );
  assert.equal(ops[0]?.from, '/tmp/x/Geogaddi/01.mp3');
});

test('buildOps sends extras to the album most tracks belong to', () => {
  const ops = buildOps({
    tracks: [
      track({ source: '1.mp3', album: 'Geogaddi', track: 1 }),
      track({ source: '2.mp3', album: 'Geogaddi', track: 2 }),
      track({ source: '3.mp3', album: 'Twoism', track: 3 }),
    ],
    extras: ['cover.jpg'],
    root: '/tmp/x',
    prefix: '',
  });
  assert.equal(ops.at(-1)?.to, 'Boards of Canada/Geogaddi/cover.jpg');
});

test('buildOps puts every disc in one album directory, renumbered', () => {
  const ops = buildOps({
    tracks: [
      track({ source: 'CD1/01.mp3', title: 'A', disc: 1, track: 1 }),
      track({ source: 'CD1/02.mp3', title: 'B', disc: 1, track: 2 }),
      track({ source: 'CD2/01.mp3', title: 'C', disc: 2, track: 1 }),
    ],
    extras: ['cover.jpg'],
    root: '/tmp/x',
    prefix: '',
  });
  assert.deepEqual(
    ops.map((o) => o.to),
    [
      'Boards of Canada/Geogaddi/01-A.mp3',
      'Boards of Canada/Geogaddi/02-B.mp3',
      'Boards of Canada/Geogaddi/03-C.mp3',
      'Boards of Canada/Geogaddi/cover.jpg',
    ],
  );
});

test('the padding width accounts for the flattened total', () => {
  const ops = buildOps({
    tracks: [
      track({ source: 'a.mp3', title: 'A', disc: 1, track: 99 }),
      track({ source: 'b.mp3', title: 'B', disc: 2, track: 5 }),
    ],
    extras: [],
    root: '/tmp/x',
    prefix: '',
  });
  assert.deepEqual(
    ops.map((o) => o.to),
    ['Boards of Canada/Geogaddi/099-A.mp3', 'Boards of Canada/Geogaddi/104-B.mp3'],
  );
});

test('findCollisions reports two tracks fighting over one destination', () => {
  const ops = buildOps({
    tracks: [
      track({ source: 'a.mp3', title: 'Dawn Chorus', track: 5 }),
      track({ source: 'b.mp3', title: 'Dawn Chorus', track: 5 }),
    ],
    extras: [],
    root: '/tmp/x',
    prefix: '',
  });
  const problems = findCollisions(ops);
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /05-Dawn Chorus\.mp3 <- a\.mp3, b\.mp3/);
});

test('findCollisions is quiet when every destination is unique', () => {
  const ops = buildOps({
    tracks: [track({ source: 'a.mp3', track: 1 }), track({ source: 'b.mp3', track: 2 })],
    extras: [],
    root: '/tmp/x',
    prefix: '',
  });
  assert.deepEqual(findCollisions(ops), []);
});
