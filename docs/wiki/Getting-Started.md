# Getting Started

This page is for a new user who has never opened the tool before.

## What You Need

- Windows
- Node.js 22 or newer
- Python 3.12 or newer
- Your own local Nostalgia OP3 game folder
- Optional: your own local MonkeyBusiness-style server folder

Python packages:

```powershell
py -m pip install ifstools pillow
```

Node packages:

```powershell
npm install
```

## Launch The App

From the project folder:

```powershell
npm run build
npm run build:ui
npm run start:app
```

Open:

```text
http://127.0.0.1:5174/
```

## Make A Basic Project

1. Set the song title and artist.
2. Pick a genre from the dropdown.
3. Load an audio file.
4. Load jacket art if you have it.
5. Set BPM and offset.
6. Add notes manually or use generation as a starting point.
7. Export a `.op3song.zip`.

## Install Into The Game

1. Set `Game directory` to your Nostalgia OP3 client folder.
2. Click `Add Current`.
3. If using a local server, set `Server directory` and click `Sync Server`.

Close the game before patching files.

