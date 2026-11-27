import readline from 'node:readline/promises';

const EOF = Symbol('eof');
type Line = string | typeof EOF;

/**
 * One readline interface for the whole run, with the lines it produces queued
 * rather than answered on demand.
 *
 * Two problems force this shape. A fresh interface per question reads ahead
 * and swallows the rest of a piped stdin, so later prompts see EOF. And a
 * single interface still loses lines that arrive during the gap between
 * questions -- on a pipe, readline drains the stream and closes while we are
 * busy extracting an archive. Queueing every line as it arrives makes the
 * timing irrelevant.
 */
let iface: readline.Interface | undefined;
const queued: string[] = [];
let waiting: ((line: Line) => void) | undefined;
let closed = false;

export class NoInputError extends Error {
  constructor() {
    super('ran out of input on stdin; pass --yes to run without prompts');
    this.name = 'NoInputError';
  }
}

function deliver(line: Line): boolean {
  if (!waiting) return false;
  const resolve = waiting;
  waiting = undefined;
  resolve(line);
  return true;
}

function session(): readline.Interface {
  if (iface) return iface;
  closed = false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('line', (line: string) => {
    if (!deliver(line)) queued.push(line);
  });
  // On a TTY, readline holds the terminal in raw mode from here until it
  // closes, so Ctrl-C arrives as a keypress, not a signal -- even while we
  // are busy extracting or copying. Unhandled, readline just closes, which
  // reads as end of input at the next prompt. Raise the real signal instead.
  rl.on('SIGINT', () => {
    // Raw mode does not echo ^C; end the prompt line so the shell's is clean.
    process.stdout.write('\n');
    process.kill(process.pid, 'SIGINT');
  });
  rl.once('close', () => {
    closed = true;
    deliver(EOF);
  });
  iface = rl;
  return rl;
}

/** Release stdin so a child process can own the terminal, then take it back. */
export async function withStdinReleased<T>(fn: () => Promise<T>): Promise<T> {
  // A closed interface throws on pause/resume, and piped input closes as soon
  // as it is drained -- which is well before the editor is done.
  const rl = closed ? undefined : iface;
  const wasRaw = process.stdin.isTTY ? process.stdin.isRaw : false;
  rl?.pause();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  try {
    return await fn();
  } finally {
    if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
    rl?.resume();
  }
}

export function closeSession(): void {
  iface?.close();
  iface = undefined;
  waiting = undefined;
  queued.length = 0;
}

/**
 * Ask a question. Throws {@link NoInputError} at end of input rather than
 * hanging or quietly treating it as an answer.
 */
export async function prompt(question: string): Promise<string> {
  const rl = session();

  const buffered = queued.shift();
  if (buffered !== undefined) {
    // Already read; echo the prompt so a piped transcript still makes sense.
    process.stdout.write(question);
    return buffered.trim();
  }
  if (closed) throw new NoInputError();

  rl.setPrompt(question);
  rl.prompt();
  const line = await new Promise<Line>((resolve) => {
    waiting = resolve;
  });
  if (line === EOF) throw new NoInputError();
  return line.trim();
}
