import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  VARIOUS_ARTISTS,
  naturalCompare,
  readTracks,
  titleFromFilename,
  trackFromFilename,
} from '../src/metadata.js';
import { UNKNOWN_ARTIST } from '../src/paths.js';
import { type Id3Tags, mp3 } from './helpers/fixtures.js';

async function withFiles(
  files: Record<string, Id3Tags | Buffer>,
  fn: (dir: string, names: string[]) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'music-inbox-test-'));
  try {
    for (const [name, value] of Object.entries(files)) {
      const full = path.join(dir, name);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, Buffer.isBuffer(value) ? value : mp3(value));
    }
    await fn(dir, Object.keys(files));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('naturalCompare orders track 2 before track 10', () => {
  assert.deepEqual(['10.mp3', '2.mp3', '1.mp3'].sort(naturalCompare), [
    '1.mp3',
    '2.mp3',
    '10.mp3',
  ]);
});

test('titleFromFilename drops a leading track number', () => {
  assert.equal(titleFromFilename('03 - Sunshine Recorder.mp3'), 'Sunshine Recorder');
  assert.equal(titleFromFilename('07_Alpha and Omega.mp3'), 'Alpha and Omega');
  assert.equal(titleFromFilename('Dawn Chorus.mp3'), 'Dawn Chorus');
});

test('titleFromFilename keeps a name that is only digits', () => {
  assert.equal(titleFromFilename('1969.mp3'), '1969');
});

test('trackFromFilename reads a leading number when there is one', () => {
  assert.equal(trackFromFilename('03 - Sunshine Recorder.mp3'), 3);
  assert.equal(trackFromFilename('Dawn Chorus.mp3'), undefined);
});

test('tags are read straight through when they are complete', async () => {
  await withFiles(
    {
      'a.mp3': {
        albumArtist: 'Boards of Canada',
        album: 'Geogaddi',
        artist: 'Boards of Canada',
        title: 'Ready Lets Go',
        track: '1/23',
      },
    },
    async (dir, names) => {
      const [track] = await readTracks(dir, names, '/inbox/whatever.zip');
      assert.deepEqual(track, {
        source: 'a.mp3',
        albumArtist: 'Boards of Canada',
        album: 'Geogaddi',
        artist: 'Boards of Canada',
        title: 'Ready Lets Go',
        track: 1,
        disc: 1,
      });
    },
  );
});

test('the disc number comes from TPOS', async () => {
  await withFiles({ 'a.mp3': { title: 'x', track: '4', disc: '2/2' } }, async (dir, names) => {
    assert.equal((await readTracks(dir, names, '/inbox/x.zip'))[0]?.disc, 2);
  });
});

test('a missing album artist falls back to the sole artist', async () => {
  await withFiles(
    {
      'a.mp3': { album: 'Geogaddi', artist: 'Boards of Canada', title: 'One', track: '1' },
      'b.mp3': { album: 'Geogaddi', artist: 'Boards of Canada', title: 'Two', track: '2' },
    },
    async (dir, names) => {
      const tracks = await readTracks(dir, names, '/inbox/x.zip');
      assert.deepEqual(new Set(tracks.map((t) => t.albumArtist)), new Set(['Boards of Canada']));
    },
  );
});

test('mixed artists with no album artist become Various Artists', async () => {
  await withFiles(
    {
      'a.mp3': { album: 'Mix', artist: 'Autechre', title: 'One', track: '1' },
      'b.mp3': { album: 'Mix', artist: 'Aphex Twin', title: 'Two', track: '2' },
    },
    async (dir, names) => {
      const tracks = await readTracks(dir, names, '/inbox/x.zip');
      assert.equal(tracks[0]?.albumArtist, VARIOUS_ARTISTS);
      // The per-track artist is untouched by the album-level fallback.
      assert.deepEqual(new Set(tracks.map((t) => t.artist)), new Set(['Autechre', 'Aphex Twin']));
    },
  );
});

test('one mistagged album name does not split the album', async () => {
  await withFiles(
    {
      'a.mp3': { albumArtist: 'BoC', album: 'Geogaddi', title: 'One', track: '1' },
      'b.mp3': { albumArtist: 'BoC', album: 'Geogaddi', title: 'Two', track: '2' },
      'c.mp3': { albumArtist: 'BoC', album: 'geogadi', title: 'Three', track: '3' },
    },
    async (dir, names) => {
      const tracks = await readTracks(dir, names, '/inbox/x.zip');
      assert.deepEqual(new Set(tracks.map((t) => t.album)), new Set(['Geogaddi']));
    },
  );
});

test('untagged files fall back to the filename and the archive name', async () => {
  await withFiles(
    {
      '01 - Ready Lets Go.mp3': Buffer.concat([Buffer.alloc(0), mp3({})]),
      '02 - Music Is Math.mp3': mp3({}),
    },
    async (dir, names) => {
      const tracks = await readTracks(dir, names, '/inbox/Geogaddi (2002).zip');
      assert.deepEqual(
        tracks.map((t) => [t.track, t.title]),
        [
          [1, 'Ready Lets Go'],
          [2, 'Music Is Math'],
        ],
      );
      assert.equal(tracks[0]?.album, 'Geogaddi (2002)');
      assert.equal(tracks[0]?.albumArtist, UNKNOWN_ARTIST);
    },
  );
});

test('files with neither tags nor numbers are numbered by natural order', async () => {
  await withFiles({ 'beta.mp3': mp3({}), 'alpha.mp3': mp3({}) }, async (dir, names) => {
    const tracks = await readTracks(dir, names, '/inbox/x.zip');
    assert.deepEqual(
      tracks.map((t) => [t.source, t.track]),
      [
        ['alpha.mp3', 1],
        ['beta.mp3', 2],
      ],
    );
  });
});

test('an unreadable file degrades to filename metadata instead of throwing', async () => {
  await withFiles({ '05 - Broken.mp3': Buffer.from('not an mp3 at all') }, async (dir, names) => {
    const [track] = await readTracks(dir, names, '/inbox/x.zip');
    assert.equal(track?.title, 'Broken');
    assert.equal(track?.track, 5);
  });
});
