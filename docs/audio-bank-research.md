# OP3 Audio Bank Research

## Goal

Custom songs should not depend on a finite pool of borrowed preview/audio identities.
The current stable fallback copies a valid official XACT soundbank (`.xsb`) and
generates matching custom wavebanks (`.xwb`). This does not overwrite official
song files, but duplicate internal soundbank names can collide while browsing.

## Findings

- OP3 uses Microsoft XACT-style soundbanks (`.xsb`) and wavebanks (`.xwb`).
- Modern DirectXTK `xwbtool` can build XACT-style `.xwb` files, but it does not
  build legacy XACT soundbanks.
- Legacy XACT/XACTBLD from the DirectX SDK June 2010 can author `.xsb` files,
  but it is deprecated and not redistributable with this mapper.
- OP3 music soundbanks are tiny and regular:
  - main song `.xsb`: 268 bytes
  - preview `.xsb`: 297 bytes
  - two fixed 64-byte internal name fields
  - one cue label: `_backtrack` or `_preview`
- XSB byte offsets 8-9 store an XACT FCS16/X.25 checksum over bytes starting at
  offset 18. String patching without updating this checksum makes the file look
  plausible but invalid to the game.

## Current Implementation

The patcher supports two modes:

- Default: copy an official donor `.xsb` untouched and generate `.xwb` files with
  the donor internal bank name. This is the safest proven mode.
- Experimental `--unique-xsb`: patch the donor `.xsb` to a unique generated
  internal bank name, then recompute the XSB FCS16 checksum and generate `.xwb`
  files with the same unique name.

CLI:

```powershell
node dist/cli.js install-project --game-dir "C:\Path\To\OP3" --project song.op3song.json --unique-xsb
```

Web UI:

Enable `Use experimental unique XACT soundbanks` in the Patcher panel before
clicking Add Current or Add File.

## Next Validation Step

Test `--unique-xsb` on one custom song only. If preview and song load work after
a full restart, reinstall more customs with the same option and stress-test
song browsing.

## Sources

- MultimediaWiki XACT format notes: https://wiki.multimedia.cx/index.php?title=XACT
- Microsoft DirectX SDK June 2010 download page: https://www.microsoft.com/en-us/download/details.aspx?id=6812
- DirectXTK XWBTool documentation: https://github.com/microsoft/DirectXTK/wiki/XWBTool
- DirectX SDK tools catalog, noting XACT is legacy SDK-only: https://walbourn.github.io/directx-sdk-tools-catalog/
