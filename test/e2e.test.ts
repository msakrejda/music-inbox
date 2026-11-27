import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { mp3, tree, writeZip } from './helpers/fixtures.js';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'src', 'cli.ts');
// Resolved here, not in the child: the child runs with a temp directory as its cwd.
const tsx = import.meta.resolve('tsx');

const COVER = Buffer.from('jpeg bytes');
const BACK = Buffer.from('back cover bytes');

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'music-inbox-e2e-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function tracks(): { one: Buffer; two: Buffer } {
  return {
    one: mp3({
      albumArtist: 'Boards of Canada',
      album: 'Geogaddi',
      artist: 'Boards of Canada',
      title: 'Ready Lets Go',
      track: '1/22',
    }),
    two: mp3({
      albumArtist: 'Boards of Canada',
      album: 'Geogaddi',
      artist: 'Boards of Canada',
      title: 'Music Is Math',
      track: '2/22',
    }),
  };
}

function cliRun(args: string[], cwd: string) {
  return run(process.execPath, ['--import', tsx, cli, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: '1' },
  });
}

test('files an archive, keeps the extras, and deletes the zip', async () => {
  await withDir(async (dir) => {
    const archive = path.join(dir, 'Geogaddi.zip');
    const target = path.join(dir, 'library');
    const { one, two } = tracks();
    await writeZip(archive, [
      { name: 'Geogaddi/01.mp3', data: one },
      { name: 'Geogaddi/02.mp3', data: two },
      { name: 'Geogaddi/cover.jpg', data: COVER },
      { name: 'Geogaddi/scans/back.jpg', data: BACK },
      { name: '__MACOSX/Geogaddi/._01.mp3', data: Buffer.from('junk') },
    ]);

    await cliRun([archive, '--target', target, '--yes'], dir);

    assert.deepEqual(await tree(target), [
      path.join('Boards of Canada', 'Geogaddi', '01-Ready Lets Go.mp3'),
      path.join('Boards of Canada', 'Geogaddi', '02-Music Is Math.mp3'),
      path.join('Boards of Canada', 'Geogaddi', 'cover.jpg'),
      path.join('Boards of Canada', 'Geogaddi', 'scans', 'back.jpg'),
    ]);

    const placed = await fs.readFile(
      path.join(target, 'Boards of Canada/Geogaddi/01-Ready Lets Go.mp3'),
    );
    assert.ok(placed.equals(one), 'MP3 bytes must be copied unchanged');
    assert.ok(
      (await fs.readFile(path.join(target, 'Boards of Canada/Geogaddi/cover.jpg'))).equals(COVER),
    );

    await assert.rejects(() => fs.access(archive), 'the archive should be deleted');
  });
});

test('--dry-run writes nothing and keeps the archive', async () => {
  await withDir(async (dir) => {
    const archive = path.join(dir, 'Geogaddi.zip');
    const target = path.join(dir, 'library');
    const { one, two } = tracks();
    await writeZip(archive, [
      { name: '01.mp3', data: one },
      { name: '02.mp3', data: two },
    ]);

    const { stdout } = await cliRun([archive, '--target', target, '--yes', '--dry-run'], dir);

    assert.match(stdout, /Would create/);
    assert.match(stdout, /01-Ready Lets Go\.mp3/);
    assert.deepEqual(await tree(target), []);
    await fs.access(archive);
  });
});

test('--keep files the tracks but leaves the archive alone', async () => {
  await withDir(async (dir) => {
    const archive = path.join(dir, 'Geogaddi.zip');
    const target = path.join(dir, 'library');
    const { one } = tracks();
    await writeZip(archive, [{ name: '01.mp3', data: one }]);

    await cliRun([archive, '--target', target, '--yes', '--keep'], dir);

    assert.deepEqual(await tree(target), [
      path.join('Boards of Canada', 'Geogaddi', '01-Ready Lets Go.mp3'),
    ]);
    await fs.access(archive);
  });
});

test('the target defaults to the working directory', async () => {
  await withDir(async (dir) => {
    const archive = path.join(dir, 'Geogaddi.zip');
    const cwd = path.join(dir, 'here');
    await fs.mkdir(cwd);
    await writeZip(archive, [{ name: '01.mp3', data: tracks().one }]);

    await cliRun([archive, '--yes'], cwd);

    assert.deepEqual(await tree(cwd), [
      path.join('Boards of Canada', 'Geogaddi', '01-Ready Lets Go.mp3'),
    ]);
  });
});

test('an existing destination is refused rather than overwritten', async () => {
  await withDir(async (dir) => {
    const archive = path.join(dir, 'Geogaddi.zip');
    const target = path.join(dir, 'library');
    const existing = path.join(target, 'Boards of Canada/Geogaddi/01-Ready Lets Go.mp3');
    await fs.mkdir(path.dirname(existing), { recursive: true });
    await fs.writeFile(existing, 'do not clobber me');
    await writeZip(archive, [{ name: '01.mp3', data: tracks().one }]);

    const { stdout, stderr } = await cliRun([archive, '--target', target, '--yes'], dir);

    assert.match(stderr, /already exists/);
    assert.match(stdout, /skipped/);
    assert.equal(await fs.readFile(existing, 'utf8'), 'do not clobber me');
    await fs.access(archive);
  });
});

test('an archive with no MP3s is skipped and kept', async () => {
  await withDir(async (dir) => {
    const archive = path.join(dir, 'notmusic.zip');
    const target = path.join(dir, 'library');
    await writeZip(archive, [{ name: 'readme.txt', data: Buffer.from('hello') }]);

    const { stdout } = await cliRun([archive, '--target', target, '--yes'], dir);

    assert.match(stdout, /no MP3 files inside/);
    assert.deepEqual(await tree(target), []);
    await fs.access(archive);
  });
});

test('a multi-disc archive lands in one directory, renumbered end to end', async () => {
  await withDir(async (dir) => {
    const archive = path.join(dir, 'Set.zip');
    const target = path.join(dir, 'library');
    await writeZip(archive, [
      {
        name: 'CD1/01.mp3',
        data: mp3({ albumArtist: 'BoC', album: 'Set', title: 'A', track: '1', disc: '1/2' }),
      },
      {
        name: 'CD2/01.mp3',
        data: mp3({ albumArtist: 'BoC', album: 'Set', title: 'B', track: '1', disc: '2/2' }),
      },
    ]);

    await cliRun([archive, '--target', target, '--yes'], dir);

    assert.deepEqual(await tree(target), [
      path.join('BoC', 'Set', '01-A.mp3'),
      path.join('BoC', 'Set', '02-B.mp3'),
    ]);
  });
});

test('a slash in the artist name does not create a stray directory', async () => {
  await withDir(async (dir) => {
    const archive = path.join(dir, 'x.zip');
    const target = path.join(dir, 'library');
    await writeZip(archive, [
      {
        name: '01.mp3',
        data: mp3({ albumArtist: 'AC/DC', album: 'Back in Black', title: 'Hells Bells', track: '1' }),
      },
    ]);

    await cliRun([archive, '--target', target, '--yes'], dir);

    assert.deepEqual(await tree(target), [
      path.join('AC-DC', 'Back in Black', '01-Hells Bells.mp3'),
    ]);
  });
});

test('several archives in one run are all filed', async () => {
  await withDir(async (dir) => {
    const target = path.join(dir, 'library');
    const first = path.join(dir, 'one.zip');
    const second = path.join(dir, 'two.zip');
    await writeZip(first, [
      { name: '01.mp3', data: mp3({ albumArtist: 'A', album: 'One', title: 'X', track: '1' }) },
    ]);
    await writeZip(second, [
      { name: '01.mp3', data: mp3({ albumArtist: 'B', album: 'Two', title: 'Y', track: '1' }) },
    ]);

    await cliRun([first, second, '--target', target, '--yes'], dir);

    assert.deepEqual(await tree(target), [
      path.join('A', 'One', '01-X.mp3'),
      path.join('B', 'Two', '01-Y.mp3'),
    ]);
    await assert.rejects(() => fs.access(first));
    await assert.rejects(() => fs.access(second));
  });
});

test('a missing archive fails before anything is written', async () => {
  await withDir(async (dir) => {
    const target = path.join(dir, 'library');
    const good = path.join(dir, 'good.zip');
    await writeZip(good, [{ name: '01.mp3', data: tracks().one }]);

    await assert.rejects(
      () => cliRun([good, path.join(dir, 'nope.zip'), '--target', target, '--yes'], dir),
      /not a file/,
    );
    assert.deepEqual(await tree(target), []);
    await fs.access(good);
  });
});

/** Drive the interactive prompts by piping answers to stdin. */
function cliInteract(
  args: string[],
  cwd: string,
  input: string,
  env: NodeJS.ProcessEnv = {},
  // Its own process group, so `kill 0` in a fake editor reaches the CLI (as
  // Ctrl-C reaches the whole foreground group) but not the test runner.
  detached = false,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsx, cli, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', ...env },
      detached,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('answers piped to stdin drive the confirm-then-delete flow', async () => {
  await withDir(async (dir) => {
    const archive = path.join(dir, 'Geogaddi.zip');
    const target = path.join(dir, 'library');
    await writeZip(archive, [{ name: '01.mp3', data: tracks().one }]);

    const { code } = await cliInteract([archive, '--target', target], dir, 'c\ny\n');

    assert.equal(code, 0);
    assert.deepEqual(await tree(target), [
      path.join('Boards of Canada', 'Geogaddi', '01-Ready Lets Go.mp3'),
    ]);
    await assert.rejects(() => fs.access(archive));
  });
});

test('answering n at the delete prompt keeps the archive', async () => {
  await withDir(async (dir) => {
    const archive = path.join(dir, 'Geogaddi.zip');
    const target = path.join(dir, 'library');
    await writeZip(archive, [{ name: '01.mp3', data: tracks().one }]);

    const { code } = await cliInteract([archive, '--target', target], dir, 'c\nn\n');

    assert.equal(code, 0);
    assert.equal((await tree(target)).length, 1);
    await fs.access(archive);
  });
});

test('edits made in $EDITOR decide where the track is filed', async () => {
  await withDir(async (dir) => {
    const archive = path.join(dir, 'Geogaddi.zip');
    const target = path.join(dir, 'library');
    await writeZip(archive, [{ name: '01.mp3', data: tracks().one }]);

    // A multi-word $EDITOR is the normal case ("emacs -nw", "code --wait"),
    // so the editor must go through a shell rather than be exec'd by name.
    const { code, stdout } = await cliInteract([archive, '--target', target], dir, 'e\nc\nn\n', {
      EDITOR: 'sed -i s/Ready/Steady/',
      VISUAL: '',
    });

    assert.equal(code, 0, stdout);
    assert.deepEqual(await tree(target), [
      path.join('Boards of Canada', 'Geogaddi', '01-Steady Lets Go.mp3'),
    ]);
  });
});

test('deleting a row in $EDITOR leaves that track out', async () => {
  await withDir(async (dir) => {
    const archive = path.join(dir, 'Geogaddi.zip');
    const target = path.join(dir, 'library');
    const { one, two } = tracks();
    await writeZip(archive, [
      { name: '01.mp3', data: one },
      { name: '02.mp3', data: two },
    ]);

    const { code, stdout } = await cliInteract([archive, '--target', target], dir, 'e\nc\nn\n', {
      EDITOR: "sed -i '/Music Is Math/d'",
      VISUAL: '',
    });

    assert.equal(code, 0, stdout);
    assert.match(stdout, /Skipping 02\.mp3/);
    assert.deepEqual(await tree(target), [
      path.join('Boards of Canada', 'Geogaddi', '01-Ready Lets Go.mp3'),
    ]);
  });
});

/** Leftover temp dirs, with TMPDIR pointed at `tmp` for the run. */
async function leftovers(tmp: string): Promise<string[]> {
  return (await fs.readdir(tmp)).filter((name) => name.startsWith('music-inbox-'));
}

test('Ctrl-C that kills the editor stops the run and removes every temp dir', async () => {
  await withDir(async (dir) => {
    const archive = path.join(dir, 'Geogaddi.zip');
    const target = path.join(dir, 'library');
    const tmp = path.join(dir, 'tmp');
    await fs.mkdir(tmp);
    await writeZip(archive, [{ name: '01.mp3', data: tracks().one }]);

    // The editor signals its whole group, then dies of it, like `code --wait`.
    const { code } = await cliInteract(
      [archive, '--target', target],
      dir,
      'e\nc\nn\n',
      { EDITOR: 'kill -INT 0; true', VISUAL: '', TMPDIR: tmp },
      true,
    );

    assert.equal(code, 130);
    assert.deepEqual(await leftovers(tmp), []);
    assert.deepEqual(await tree(target), []);
    await fs.access(archive);
  });
});

test('Ctrl-C caught by the editor leaves the run going', async () => {
  await withDir(async (dir) => {
    const archive = path.join(dir, 'Geogaddi.zip');
    const target = path.join(dir, 'library');
    const tmp = path.join(dir, 'tmp');
    await fs.mkdir(tmp);
    await writeZip(archive, [{ name: '01.mp3', data: tracks().one }]);

    // Like vim or emacs: the editor shrugs off SIGINT and the user carries on.
    const { code, stdout } = await cliInteract(
      [archive, '--target', target],
      dir,
      'e\nc\nn\n',
      { EDITOR: "trap '' INT; kill -INT 0; sed -i s/Ready/Steady/", VISUAL: '', TMPDIR: tmp },
      true,
    );

    assert.equal(code, 0, stdout);
    assert.deepEqual(await tree(target), [
      path.join('Boards of Canada', 'Geogaddi', '01-Steady Lets Go.mp3'),
    ]);
    assert.deepEqual(await leftovers(tmp), []);
  });
});

test('SIGTERM while the editor is open removes every temp dir', async () => {
  await withDir(async (dir) => {
    const archive = path.join(dir, 'Geogaddi.zip');
    const target = path.join(dir, 'library');
    const tmp = path.join(dir, 'tmp');
    await fs.mkdir(tmp);
    await writeZip(archive, [{ name: '01.mp3', data: tracks().one }]);

    // $PPID of the `sh -c` running the editor is the CLI itself.
    const { code } = await cliInteract([archive, '--target', target], dir, 'e\nc\nn\n', {
      EDITOR: 'kill -TERM $PPID; sleep 1; true',
      VISUAL: '',
      TMPDIR: tmp,
    });

    assert.equal(code, 143);
    assert.deepEqual(await leftovers(tmp), []);
    assert.deepEqual(await tree(target), []);
  });
});

test('s skips the archive and writes nothing', async () => {
  await withDir(async (dir) => {
    const archive = path.join(dir, 'Geogaddi.zip');
    const target = path.join(dir, 'library');
    await writeZip(archive, [{ name: '01.mp3', data: tracks().one }]);

    const { code, stdout } = await cliInteract([archive, '--target', target], dir, 's\n');

    assert.equal(code, 0);
    assert.match(stdout, /skipped/);
    assert.deepEqual(await tree(target), []);
    await fs.access(archive);
  });
});

test('q stops the run without reaching the delete prompt', async () => {
  await withDir(async (dir) => {
    const target = path.join(dir, 'library');
    const first = path.join(dir, 'one.zip');
    const second = path.join(dir, 'two.zip');
    await writeZip(first, [{ name: '01.mp3', data: tracks().one }]);
    await writeZip(second, [{ name: '01.mp3', data: tracks().two }]);

    const { code, stdout } = await cliInteract([first, second, '--target', target], dir, 'q\n');

    assert.equal(code, 0);
    assert.doesNotMatch(stdout, /Delete .* archive/);
    assert.deepEqual(await tree(target), []);
    await fs.access(first);
    await fs.access(second);
  });
});

test('running out of input without --yes fails loudly instead of doing nothing', async () => {
  await withDir(async (dir) => {
    const archive = path.join(dir, 'Geogaddi.zip');
    const target = path.join(dir, 'library');
    await writeZip(archive, [{ name: '01.mp3', data: tracks().one }]);

    const { code, stderr } = await cliInteract([archive, '--target', target], dir, '');

    assert.equal(code, 2);
    assert.match(stderr, /--yes/);
    assert.deepEqual(await tree(target), []);
    await fs.access(archive);
  });
});

test('--help exits cleanly and describes the naming pattern', async () => {
  await withDir(async (dir) => {
    const { stdout } = await cliRun(['--help'], dir);
    assert.match(stdout, /AlbumArtist.*Album.*TrackNumber.*Title/s);
  });
});
