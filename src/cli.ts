#!/usr/bin/env node
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { executeOps, findExisting, withTempDir } from './apply.js';
import { readTracks } from './metadata.js';
import { buildOps, commonRoot, findCollisions, isMultiDisc } from './paths.js';
import { reviewInEditor } from './review.js';
import { NoInputError, closeSession } from './session.js';
import * as ui from './ui.js';
import { extractArchive } from './zip.js';
import type { ArchiveResult, FileOp, TrackMeta } from './types.js';

const USAGE = `Usage: music-inbox [options] <archive.zip>...

File incoming MP3 archives into a music library as
  <target>/<AlbumArtist>/<Album>/<TrackNumber>-<Title>.mp3
with any cover art and other extras copied alongside the tracks.

Options:
  -t, --target <dir>  Library root to file into (default: current directory)
      --dry-run       Show what would be created without writing anything
  -y, --yes           Accept the metadata as read and delete archives, no prompts
      --keep          Never offer to delete the archives
  -h, --help          Show this help
`;

class Quit extends Error {}

interface Options {
  target: string;
  dryRun: boolean;
  yes: boolean;
  keep: boolean;
}

async function processArchive(archive: string, opts: Options): Promise<ArchiveResult> {
  const name = path.basename(archive);
  return withTempDir(async (temp) => {
    const entries = await extract(archive, temp);
    if (entries === null) {
      return { archive, status: 'failed', created: [], reason: 'could not read the archive' };
    }

    const mp3s = entries.filter((e) => path.extname(e).toLowerCase() === '.mp3');
    const extras = entries.filter((e) => path.extname(e).toLowerCase() !== '.mp3');
    if (mp3s.length === 0) {
      return { archive, status: 'skipped', created: [], reason: 'no MP3 files inside' };
    }

    const prefix = commonRoot(entries);
    const tracks = await readTracks(temp, mp3s, archive);

    const ops = await confirmPlan(name, tracks, extras, temp, prefix, opts);
    if (ops === null) return { archive, status: 'skipped', created: [], reason: 'skipped' };

    if (opts.dryRun) {
      console.log(ui.dim(`\nWould create in ${opts.target}:`));
      ui.printCreated(
        ops.map((o) => o.to),
        opts.target,
      );
      return { archive, status: 'placed', created: [] };
    }

    const created = await executeOps(ops, opts.target);
    console.log(ui.dim('\nCreated:'));
    ui.printCreated(created, opts.target);
    return { archive, status: 'placed', created };
  });
}

async function extract(archive: string, temp: string): Promise<string[] | null> {
  try {
    return await extractArchive(archive, temp);
  } catch (err) {
    console.error(ui.error(`  ${err instanceof Error ? err.message : String(err)}`));
    return null;
  }
}

/**
 * Show the tracks, let the user fix them, and keep looping until the plan is
 * both approved and free of collisions. Returns null if the archive is skipped.
 */
async function confirmPlan(
  name: string,
  initial: readonly TrackMeta[],
  extras: readonly string[],
  temp: string,
  prefix: string,
  opts: Options,
): Promise<FileOp[] | null> {
  let tracks = [...initial];

  for (;;) {
    console.log('');
    ui.printTracks(tracks, isMultiDisc(tracks));
    if (extras.length > 0) {
      console.log(ui.dim(`\n${extras.length} other file(s) will be copied alongside the tracks.`));
    }

    const action = opts.yes ? 'continue' : await ui.askAction();
    if (action === 'skip') return null;
    if (action === 'quit') throw new Quit();
    if (action === 'edit') {
      const result = await reviewInEditor(tracks, isMultiDisc(tracks));
      if (result.tracks.length === 0) {
        console.log(ui.warn('Every track was removed; skipping this archive.'));
        return null;
      }
      for (const source of result.skipped) {
        console.log(ui.warn(`Skipping ${source} (removed from the list).`));
      }
      tracks = result.tracks;
      continue;
    }

    const ops = buildOps({ tracks, extras, root: temp, prefix });
    const problems = [
      ...findCollisions(ops),
      ...(opts.dryRun ? [] : await findExisting(ops, opts.target)).map((p) => `${p} already exists`),
    ];
    if (problems.length === 0) return ops;

    console.error(ui.error(`\n${name}: cannot file these without overwriting something:`));
    for (const problem of problems) console.error(ui.error(`  ${problem}`));
    if (opts.yes) return null;
    console.log(ui.dim('Edit the metadata to resolve it, or skip this archive.'));
  }
}

async function resolveTarget(raw: string): Promise<string> {
  const target = path.resolve(raw);
  await fs.mkdir(target, { recursive: true });
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) throw new Error(`target is not a directory: ${target}`);
  await fs.access(target, constants.W_OK);
  return target;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: {
      target: { type: 'string', short: 't' },
      'dry-run': { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      keep: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  const opts: Options = {
    target: await resolveTarget(values.target ?? process.cwd()),
    dryRun: values['dry-run'],
    yes: values.yes,
    keep: values.keep,
  };

  // Fail before touching anything if an argument is wrong.
  for (const archive of positionals) {
    const stat = await fs.stat(archive).catch(() => null);
    if (!stat?.isFile()) throw new Error(`not a file: ${archive}`);
  }

  const results: ArchiveResult[] = [];
  let quit = false;
  let noInput = false;
  for (const archive of positionals) {
    console.log(ui.bold(`\n=== ${path.basename(archive)}`));
    try {
      results.push(await processArchive(path.resolve(archive), opts));
    } catch (err) {
      if (err instanceof Quit) {
        quit = true;
        break;
      }
      // End of input is about the run, not this archive: every later prompt
      // would hit it too, so stop rather than failing each one in turn.
      if (err instanceof NoInputError) {
        noInput = true;
        quit = true;
        console.error(ui.error(err.message));
        break;
      }
      const reason = err instanceof Error ? err.message : String(err);
      console.error(ui.error(`  ${reason}`));
      results.push({ archive, status: 'failed', created: [], reason });
    }
  }

  summarize(results);

  const placed = results.filter((r) => r.status === 'placed');
  if (!quit && !opts.dryRun && !opts.keep && placed.length > 0) {
    await maybeDelete(placed, opts.yes);
  }

  if (noInput) return 2;
  return results.some((r) => r.status === 'failed') ? 1 : 0;
}

function summarize(results: readonly ArchiveResult[]): void {
  if (results.length === 0) return;
  console.log(ui.bold('\n=== Summary'));
  for (const r of results) {
    const files = r.created.length > 0 ? ` (${r.created.length} files)` : '';
    const detail = r.reason ? ` - ${r.reason}` : '';
    const line = `  ${r.status.padEnd(7)} ${path.basename(r.archive)}${files}${detail}`;
    console.log(r.status === 'failed' ? ui.error(line) : r.status === 'skipped' ? ui.warn(line) : line);
  }
}

async function maybeDelete(placed: readonly ArchiveResult[], assumeYes: boolean): Promise<void> {
  console.log(ui.bold('\nArchives ready to delete:'));
  for (const r of placed) console.log(`  ${r.archive}`);

  if (!assumeYes && !(await ui.confirm(`\nDelete ${placed.length} archive(s)?`))) {
    console.log(ui.dim('Left in place.'));
    return;
  }
  for (const r of placed) {
    try {
      await fs.rm(r.archive);
      console.log(ui.dim(`  deleted ${path.basename(r.archive)}`));
    } catch (err) {
      console.error(ui.error(`  could not delete ${r.archive}: ${String(err)}`));
    }
  }
}

main().then(
  (code) => {
    closeSession();
    process.exitCode = code;
  },
  (err: unknown) => {
    closeSession();
    // Reaching EOF without --yes means nothing was confirmed, so nothing ran.
    console.error(ui.error(err instanceof Error ? err.message : String(err)));
    process.exitCode = err instanceof NoInputError ? 2 : 1;
  },
);
