# Known Limitations

This project is still a prototype.

## Automapper Quality

Generated charts need review. MIDI-assisted generation is much better than audio-only generation, but neither replaces a human mapper.

## Local OP3 Assumptions

The patcher was developed against a patched/decrypted local OP3-style folder structure. Other game versions may differ.

## Local Server Assumptions

Server sync assumes a MonkeyBusiness-style path:

```text
modules/nostalgia/music_list.xml
```

Different server setups may need different sync behavior.

## No Bundled Game Assets

The repo does not include game data, server data, audio, jackets, or extracted assets.

Users must provide their own local files.

## Windows First

The current workflow is Windows-first because the target game/client setup and patching workflow are Windows-based.

## Patcher Safety

Close the game before patching. Keep backups of your game folder. Use remove only for custom songs.

