/** One MP3 from an archive, with the metadata we will file it under. */
export interface TrackMeta {
  /** Path of the file relative to the archive root. Never edited by the user. */
  source: string;
  albumArtist: string;
  album: string;
  artist: string;
  title: string;
  track: number;
  disc: number;
}

/** A single file copy, resolved but not yet performed. */
export interface FileOp {
  /** Absolute path inside the temporary extraction directory. */
  from: string;
  /** Destination path, relative to the target directory. */
  to: string;
  kind: 'track' | 'extra';
}

export interface ArchiveResult {
  archive: string;
  status: 'placed' | 'skipped' | 'failed';
  /** Paths created, relative to the target directory. */
  created: string[];
  reason?: string;
}
