# Nostalgia Chart Maker

TypeScript toolchain for creating, editing, packaging, and installing custom Nostalgia OP3 song charts.

It can:

- edit/export `.op3song.zip` packages in a browser-based mapper UI
- import shared `.op3song.zip` packages with audio and jacket art
- install projects into a user-specified game directory
- generate OP3 `music_score` XML charts from audio analysis, BPM, and density settings
- create custom song folders under `data_op3/sound/music`
- register new ASCII-safe custom song entries in `data_op3/sound/music_list.xml`
- convert MP3/audio sources to playable PCM XWB banks using the known-good OP3 alias method
- build large and small jacket/title assets from user-provided image metadata
- remove custom entries again

This repo should not include game data, arcade server data, SpiceTools binaries, extracted assets, or commercial audio. Users provide their own game directory in the Web UI patcher.

## Requirements

- Node.js 22+
- Python 3.12+
- Python packages for IFS jacket patching:

```powershell
py -m pip install ifstools pillow
```

## Usage

From this folder:

```powershell
npm install
npm run build
npm run build:ui
```

To launch the combined Web UI and patcher API:

```powershell
npm run start:app
```

Then open:

```text
http://127.0.0.1:5174/
```

To patch from the Web UI:

1. Load or create a project.
2. Set the game directory to your local Nostalgia OP3 client folder.
3. Optionally set a MonkeyBusiness server directory and enable server sync.
4. Use `Add Current`.

CLI install is also available:

```powershell
npm run install:project -- --game-dir "C:\Games\Nostalgia OP 3" --project ".\m_custom0001_aishite.op3song.json"
```
