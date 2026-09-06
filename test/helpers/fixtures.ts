import fs from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from 'node:zlib';

export interface Id3Tags {
  albumArtist?: string;
  album?: string;
  artist?: string;
  title?: string;
  track?: string;
  disc?: string;
}

/** ID3v2.3 text frame: 4-byte id, big-endian size, 2 flag bytes, UTF-8 payload. */
function textFrame(id: string, value: string): Buffer {
  const payload = Buffer.concat([Buffer.from([0x03]), Buffer.from(value, 'utf8'), Buffer.from([0])]);
  const head = Buffer.alloc(10);
  head.write(id, 0, 'latin1');
  head.writeUInt32BE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

/** ID3v2 sizes are "syncsafe": 7 bits per byte, high bit always clear. */
function syncsafe(n: number): Buffer {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

/**
 * MPEG-1 Layer III, 128 kbps, 44.1 kHz, joint stereo. 144 * 128000 / 44100
 * rounds down to a 417-byte frame; the payload is silence.
 */
function silentFrames(count: number): Buffer {
  const frame = Buffer.alloc(417);
  Buffer.from([0xff, 0xfb, 0x90, 0x64]).copy(frame);
  return Buffer.concat(Array.from({ length: count }, () => frame));
}

/** A minimal but genuinely parseable MP3 carrying the given ID3v2.3 tags. */
export function mp3(tags: Id3Tags): Buffer {
  const frames: Buffer[] = [];
  if (tags.albumArtist) frames.push(textFrame('TPE2', tags.albumArtist));
  if (tags.album) frames.push(textFrame('TALB', tags.album));
  if (tags.artist) frames.push(textFrame('TPE1', tags.artist));
  if (tags.title) frames.push(textFrame('TIT2', tags.title));
  if (tags.track) frames.push(textFrame('TRCK', tags.track));
  if (tags.disc) frames.push(textFrame('TPOS', tags.disc));

  const body = Buffer.concat(frames);
  const header = Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([0x03, 0x00, 0x00]),
    syncsafe(body.length),
  ]);
  return Buffer.concat([header, body, silentFrames(8)]);
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Write a stored (uncompressed) zip. Enough of the format for yauzl to read
 * it back, which keeps the tests free of binary fixtures and shell-outs.
 */
export function zip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const sum = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x2821, 12); // mod date (2000-01-01)
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made by: unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x2821, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0o100644 * 0x10000, 38); // external attrs: regular file (<<16 would overflow)
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + entry.data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([Buffer.concat(locals), centralBuf, end]);
}

export async function writeZip(file: string, entries: readonly ZipEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, zip(entries));
}

/** Every file under `dir`, as sorted paths relative to it. */
export async function tree(dir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(path.relative(dir, full));
    }
  }
  await walk(dir);
  return found.sort();
}
