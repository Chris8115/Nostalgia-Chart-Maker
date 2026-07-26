# Nostalgia Chart Maker

Nostalgia Chart Maker is a community toolchain for creating, editing, packaging, and installing custom charts for Nostalgia OP3.

The app is built around a browser editor plus a small local patcher API. A chart author can load audio, create or generate note charts, package the project as a shareable `.op3song.zip`, and patch that project into their own local game folder.

This repository contains only the tool. It must not contain game data, arcade server data, SpiceTools binaries, extracted Konami assets, commercial music, or jacket images from copyrighted releases.

## Current Status

This is an early prototype. It can already install playable custom songs, package projects, build jacket/title assets, and sync the server-side music list used by MonkeyBusiness-style local servers. The editor and automapper are still evolving, so generated charts should be treated as a starting point rather than finished official-quality charts.

## What It Can Do

- Edit OP3-style charts in a browser UI.
- Load audio files for preview and chart generation.
- Load MIDI files as a cleaner source for generated note placement.
- Export shareable `.op3song.zip` packages.
- Import `.op3song.zip` packages that include project JSON, audio, MIDI, and jacket art.
- Install a project into a user-selected Nostalgia OP3 game directory.
- Create custom song folders under `data_op3/sound/music`.
- Register custom songs in `data_op3/sound/music_list.xml`.
- Convert common audio sources into playable PCM XWB/XSB audio banks.
- Build large jacket art, small song-select jackets, and title text images.
- Remove custom songs added by the tool.
- Copy the patched `music_list.xml` into a local server directory.
- Analyze official chart XMLs to understand density, spacing, long-note ratio, and key-width style.

## Requirements

- Windows
- Node.js 22 or newer
- Python 3.12 or newer
- A local Nostalgia OP3 game folder that you legally provide yourself
- Optional: a local MonkeyBusiness-style server folder if you want server music-list sync

Install the Python packages used for jacket/IFS patching:

```powershell
py -m pip install ifstools pillow
```

Install Node dependencies:

```powershell
npm install
```

## First Run

From the project folder:

```powershell
cd "C:\path\to\Nostalgia-Chart-Maker"
npm install
npm run build
npm run build:ui
npm run start:app
```

Then open:

```text
http://127.0.0.1:5174/
```

`npm run start:app` starts the local patcher/API server and serves the built Web UI from `ui-dist`.

## Development Mode

For normal use, `npm run start:app` is enough. For development, use two terminals:

```powershell
npm run build
npm run dev:api
```

```powershell
npm run dev:ui
```

The Vite dev UI runs separately, while the API continues to handle patching and server-side generation.

## Basic Workflow

1. Open the Web UI.
2. Set the song title, artist, mapper text, genre, BPM, and offset.
3. Load an audio file.
4. Optionally load a MIDI file if you have one.
5. Generate charts or place/edit notes manually.
6. Load a jacket image.
7. Export a `.op3song.zip` to share the project.
8. Set your game directory.
9. Use `Add Current` to patch it into the game.
10. If using a local server, set the server directory and use `Sync Server`.

## Project Packages

The preferred sharing format is:

```text
.op3song.zip
```

A package can contain:

- `project.op3song.json`: metadata and chart data
- `audio/...`: the source audio file
- `midi/...`: optional MIDI source
- `jacket/...`: source jacket image
- `README.txt`: small package note

When imported, the Web UI restores the project metadata, charts, audio, MIDI, and jacket image if they are present in the zip.

## Important Fields

### Title and Artist

Displayed in-game on the song-select card and detail page. The installer also generates title art used by the game UI.

### Mapper Text

The description/subtitle line shown on the song card. The default is:

```text
Community custom chart
```

### Genre

The UI limits genre/category to known game categories to avoid writing unknown category values into `music_list.xml`.

Current options:

- Classic
- Pop
- Anime
- Touhou / Internet
- BEMANI
- Nostalgia Original

### BPM

Used for beat guides, snapping, generation, and chart timing structure. If BPM is wrong, notes may look close in the editor but feel wrong in-game.

### Offset

Offset is the first-beat timing in milliseconds. In the editor, changing offset can optionally shift notes with the beat grid. This is meant to help align the visible beat grid to the actual song timing without regenerating every time.

### Song ID

Custom songs should use an ID like:

```text
M_CUSTOM0001_SONGNAME
```

The installer writes files using this ID. Keep it ASCII-safe: letters, numbers, and underscores are safest.

## Patching Into The Game

In the Web UI patcher panel:

- `Game directory` should point to the root of your Nostalgia OP3 client folder.
- The folder should contain `data_op3/sound/music_list.xml`.
- `Add Current` installs the currently open project.
- `Install Project` installs a project JSON by path.
- `Remove` removes a custom song basename from the game folder.

When installing, the tool writes or updates:

```text
data_op3/sound/music/<custom_song_id>/
data_op3/sound/music_list.xml
data/jacket/jkms_l/...
data/jacket/jkms_s/...
prop/filepath.info
```

The tool creates `.op3-mapper.bak` backups for key files before first modification when possible.

## Server Sync

Some local setups need the server-side music list to match the game-side music list, especially for jacket/title data and song metadata to behave correctly.

If you use a MonkeyBusiness-style server:

1. Set `Server directory` to the server root.
2. Make sure it contains:

```text
modules/nostalgia/
```

3. Enable `Sync MonkeyBusiness music list after changes`.
4. Use `Add Current`, `Remove`, or `Sync Server`.

Server sync copies:

```text
<game directory>/data_op3/sound/music_list.xml
```

to:

```text
<server directory>/modules/nostalgia/music_list.xml
```

This does not copy audio, charts, jackets, or game files to the server. It only updates the server's `music_list.xml` metadata copy.

## Audio Installation

The installer converts user-provided audio into a game-readable XWB/XSB pair using an internal PCM template/alias method discovered during development.

The practical effect:

- You can provide MP3/WAV-style source audio.
- The tool bakes it into the custom song folder.
- In-game preview/background audio should use the installed custom audio.

If a song previews with distortion or fails to play, regenerate/reinstall with a clean audio source and make sure the game is closed while patching.

## Jacket And Title Images

The tool builds both large and small jacket/title assets:

- Large art appears on the song detail/difficulty page.
- Small art appears in the book/song list.
- Title text is rendered into game UI texture atlases.

Use square jacket art when possible. Large, clear images work best because the game displays the art in multiple sizes.

If title or jacket art appears black/missing:

- Close the game before reinstalling.
- Reinstall the current project.
- Sync the server music list if your setup needs it.
- Confirm the project has a valid jacket image loaded.

## Chart Editing

Charts are stored per difficulty:

- Normal
- Hard
- Expert
- Real

Notes use the OP3 keyboard range `0-27`.

Supported note types:

- Tap
- Hold
- Trill

The validator blocks dangerous overlaps, such as taps under active holds/trills or holds/trills overlapping each other.

## Auto Generation

The generator has two paths:

### MIDI-assisted generation

If you load a MIDI file, the server-side Python generator parses MIDI note timing, tempo, pitch, velocity, and duration. This usually gives much cleaner melody-following than audio-only analysis.

This is the recommended path when available.

### Audio-only generation

If no MIDI is provided, the generator analyzes the waveform and spectral content. This can find beats and broad melodic motion, but it is less reliable than MIDI and should be treated as a rough draft.

For good community charts, expect to manually review and edit generated notes.

## Official Chart Analysis

You can summarize style data from your own local game folder:

```powershell
npm run analyze:official -- "C:\Games\Nostalgia OP 3"
```

This scans official chart XML files and reports things like:

- note count
- notes per minute
- median note gap
- note width
- long-note ratio
- hand balance

This is useful when tuning generated charts against real OP3 chart style.

## CLI Usage

Build first:

```powershell
npm run build
```

Install a project:

```powershell
npm run install:project -- --game-dir "C:\Games\Nostalgia OP 3" --project "C:\Charts\song.op3song.json"
```

Positional form also works:

```powershell
node dist/cli.js install-project "C:\Games\Nostalgia OP 3" "C:\Charts\song.op3song.json"
```

Use unique XSB aliases if you are testing preview/audio-bank isolation:

```powershell
npm run install:project -- --game-dir "C:\Games\Nostalgia OP 3" --project "C:\Charts\song.op3song.json" --unique-xsb
```

Remove a custom song:

```powershell
node dist/cli.js remove --basename M_CUSTOM0001_SONGNAME
```

The remove command is intended for custom `M_CUSTOM...` entries only.

## What Not To Commit

Do not commit:

- `node_modules`
- `dist`
- `ui-dist`
- `scratch`
- game folders
- server folders
- SpiceTools binaries
- extracted game assets
- commercial audio files
- jacket art you do not have rights to distribute
- personal `.op3song.zip` exports containing copyrighted audio/art

Users should provide their own game directory, audio, MIDI, and jacket images.

## Contributing And Safety

See `CONTRIBUTING.md` before opening a pull request.

Important rules:

- Keep game files and copyrighted media out of the repository.
- Keep the patcher API local. Do not expose it to the public internet.
- Include build/test notes with pull requests.
- Report sensitive issues using the guidance in `SECURITY.md`.

## Detailed Guides

Beginner-friendly guide pages live in `docs/wiki/`:

- [Getting Started](docs/wiki/Getting-Started.md)
- [Game Directory Setup](docs/wiki/Game-Directory-Setup.md)
- [Server Sync](docs/wiki/Server-Sync.md)
- [Project Package Format](docs/wiki/Project-Package-Format.md)
- [Chart Editing Basics](docs/wiki/Chart-Editing-Basics.md)
- [Automapper Notes](docs/wiki/Automapper-Notes.md)
- [Known Limitations](docs/wiki/Known-Limitations.md)

## Repository Layout

```text
src/
  cli.ts                 CLI patch/install commands
  server.ts              local Web UI API and patcher server
  shared/project.ts      project schema and validation
  ui/                    React editor UI

scripts/
  generate_chart.py      server-side chart generator
  analyze_official_charts.py
  build_jacket.py
  build_small_jacket.py

docs/
  wiki/                   beginner and deep-dive guide pages
  audio-bank-research.md notes from audio-bank experiments

backups/
  legacy development references
```

## License

This project is licensed under GPLv3. See `LICENSE`.

GPLv3 allows community use, modification, and redistribution, but redistributed modified versions must also provide source code under the same license.
