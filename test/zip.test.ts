import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractArchive, safeEntryName } from '../src/zip.js';
import { tree, writeZip } from './helpers/fixtures.js';

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'music-inbox-zip-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('safeEntryName rejects paths that escape the extraction directory', () => {
  assert.equal(safeEntryName('../../etc/passwd'), null);
  assert.equal(safeEntryName('a/../../b.mp3'), null);
  assert.equal(safeEntryName('/etc/passwd'), null);
  assert.equal(safeEntryName('C:/Windows/System32/x.dll'), null);
});

test('safeEntryName skips directories and packaging noise', () => {
  assert.equal(safeEntryName('Album/'), null);
  assert.equal(safeEntryName('__MACOSX/Album/._01.mp3'), null);
  assert.equal(safeEntryName('Album/.DS_Store'), null);
  assert.equal(safeEntryName('Album/Thumbs.db'), null);
});

test('safeEntryName normalises backslash separators', () => {
  assert.equal(safeEntryName('Album\\01.mp3'), 'Album/01.mp3');
});

test('safeEntryName passes ordinary members through', () => {
  assert.equal(safeEntryName('Album/01.mp3'), 'Album/01.mp3');
  assert.equal(safeEntryName('cover.jpg'), 'cover.jpg');
});

test('extractArchive writes every member, creating directories as needed', async () => {
  await withDir(async (dir) => {
    const archive = path.join(dir, 'a.zip');
    const out = path.join(dir, 'out');
    await fs.mkdir(out);
    await writeZip(archive, [
      { name: 'Album/01.mp3', data: Buffer.from('one') },
      { name: 'Album/cover.jpg', data: Buffer.from('jpeg') },
      { name: 'Album/scans/back.jpg', data: Buffer.from('back') },
    ]);

    const written = await extractArchive(archive, out);
    assert.deepEqual(written.sort(), ['Album/01.mp3', 'Album/cover.jpg', 'Album/scans/back.jpg']);
    assert.deepEqual(await tree(out), [
      path.join('Album', '01.mp3'),
      path.join('Album', 'cover.jpg'),
      path.join('Album', 'scans', 'back.jpg'),
    ]);
    assert.equal(await fs.readFile(path.join(out, 'Album/01.mp3'), 'utf8'), 'one');
  });
});

test('a traversal entry poisons the whole archive rather than escaping', async () => {
  await withDir(async (dir) => {
    const archive = path.join(dir, 'evil.zip');
    const out = path.join(dir, 'out');
    await fs.mkdir(out);
    await writeZip(archive, [
      { name: '../escaped.txt', data: Buffer.from('nope') },
      { name: 'Album/01.mp3', data: Buffer.from('one') },
    ]);

    // yauzl refuses the entry outright, so the archive fails instead of being
    // partially extracted. safeEntryName is the second line of defence for the
    // forms yauzl does allow through.
    await assert.rejects(() => extractArchive(archive, out), /invalid relative path/);
    await assert.rejects(() => fs.access(path.join(dir, 'escaped.txt')));
    await assert.rejects(() => fs.access(path.join(out, '..', 'escaped.txt')));
  });
});

test('extractArchive rejects a file that is not a zip', async () => {
  await withDir(async (dir) => {
    const archive = path.join(dir, 'bad.zip');
    await fs.writeFile(archive, 'definitely not a zip file');
    await assert.rejects(() => extractArchive(archive, dir));
  });
});
