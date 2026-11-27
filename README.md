# music-inbox

File incoming MP3 archives into a music library.

For each incoming `.zip`, `music-inbox` extracts to a temp directory,
reads the ID3 tags, stops for amendments in `$EDITOR` if necessary,
then files the tracks as:

```
<target>/<AlbumArtist>/<Album>/<TrackNumber>-<Title>.mp3
```

Cover art and any other non-MP3 files are copied into the same album
directory, keeping whatever subdirectory structure they had inside the
zip. Once everything is completed, it lists created files and prompts
to delete the archives.

## Usage

```
music-inbox [options] <archive.zip>...

  -t, --target <dir>  Directory to file into (default: current directory)
      --dry-run       Show what would be created without writing anything
  -y, --yes           Accept metadata as-is and delete archives, skip prompts
      --keep          Never prompt to delete the archives
  -h, --help          Show this help
```

```bash
music-inbox ~/inbox/*.zip --target ~/Music
```

Exit status is 0 on success, 1 if an archive failed, and 2 if stdin
ran out while waiting for an answer (use `--yes` for non-interactive
runs).

## Reviewing the metadata

At each archive you get `[c]ontinue, [e]dit, [s]kip, [q]uit`. Choosing
`e` opens a tab-separated table in `$VISUAL`/`$EDITOR`:

```
# Id	AlbumArtist	Album	Track	Artist	Title
1	Boards of Canada	Geogaddi	1	Boards of Canada	Ready Lets Go
2	Boards of Canada	Geogaddi	2	Boards of Canada	Music Is Math
```

The `Id` column must not be edited: it is how your changes are
matched back, so rows can be reordered freely, and a find-and-replace
across the whole table is safe. Delete a whole line to leave that
track out. If a row cannot be parsed, the
editor reopens with the problems listed at the top rather than
discarding your work.

A `Disc` column appears only when the archive actually spans several
discs. Discs are flattened into a single album directory with one
continuous run of track numbers: if disc 1 ends at track 12, disc 2's
track 1 is filed as `13`. Discs are chained in numeric order.

Edits only affect where files are filed. The MP3s themselves are
copied byte-for-byte and their tags are never rewritten.

## When tags are missing

Album-level fields are decided once per archive by majority vote, so
one mistagged file cannot split an album across two directories. Each
field falls back in turn:

| Field        | Falls back to                                                          |
| ------------ | ---------------------------------------------------------------------- |
| Title        | the filename, minus any leading track number                           |
| Track        | a leading number in the filename, else position in natural sort order  |
| Artist       | the album artist                                                       |
| Album artist | the sole artist if they all agree, else `Various Artists`              |
| Album        | the archive's filename                                                 |

Characters that cannot go in a path are replaced rather than dropped,
so `AC/DC` files under `AC-DC`.

## Safety

- Nothing is ever overwritten. If a destination already exists, the
  archive is refused with the conflicts listed.
- Archives are deleted only after everything has been placed, and only
  after confirmation.
- Ctrl-C at a prompt or mid-archive stops the run and removes its
  temporary files. While the editor is open, Ctrl-C belongs to the
  editor.
- Extraction refuses entries that would escape the temp directory, and
  skips symlinks and packaging noise (`__MACOSX/`, `.DS_Store`,
  `Thumbs.db`).

## Development

```bash
npm install
npm test         # node:test via tsx
npm run typecheck
npm run build    # tsc -> dist/
npm run dev -- ~/inbox/album.zip --target ~/Music
```
