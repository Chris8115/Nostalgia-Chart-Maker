# Contributing

Thanks for helping improve Nostalgia Chart Maker.

## Before You Start

- Do not submit game files, server files, SpiceTools binaries, extracted assets, commercial audio, jacket art, or exported song packages containing copyrighted material.
- Use your own local game directory for testing.
- Keep changes focused. Small pull requests are much easier to review.

## Development Setup

```powershell
npm install
npm run build
npm run build:ui
```

Run the app:

```powershell
npm run start:app
```

Open:

```text
http://127.0.0.1:5174/
```

## Pull Request Checklist

- `npm run build` passes.
- `npm run build:ui` passes.
- No generated folders are included.
- No copyrighted media or game data is included.
- README/docs are updated when behavior changes.

## Good First Areas

- Editor usability
- Chart validation
- Audio/MIDI generation quality
- Documentation
- Safer install/remove flows
- Cross-version OP3 testing notes

