# Server Sync

Some local setups need the server-side music list to match the game-side music list.

This matters because the game and server can both care about song metadata.

## Expected Server Folder

Set `Server directory` to the root of your local server folder.

The tool expects:

```text
modules/nostalgia/
```

## What Sync Server Does

Server sync copies this file:

```text
<game directory>/data_op3/sound/music_list.xml
```

to:

```text
<server directory>/modules/nostalgia/music_list.xml
```

That is all it copies.

It does not copy audio, charts, game assets, jacket files, or server binaries.

## When To Use It

Use `Sync Server` after:

- adding a custom song
- removing a custom song
- changing title, artist, genre, description, or levels
- reinstalling a project whose metadata changed

If your song appears in the game but metadata or art behaves strangely, sync the server music list and restart the game/server.

