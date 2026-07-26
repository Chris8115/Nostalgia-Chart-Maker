# Game Directory Setup

The game directory is the root folder of your local Nostalgia OP3 client.

The patcher expects this file to exist:

```text
data_op3/sound/music_list.xml
```

The patcher also expects the normal game asset folders to exist, including:

```text
data_op3/sound/music/
data/jacket/jkms_l/
data/jacket/jkms_s/
prop/filepath.info
```

## What Add Current Changes

When you click `Add Current`, the tool can update:

```text
data_op3/sound/music/<custom_song_id>/
data_op3/sound/music_list.xml
data/jacket/jkms_l/
data/jacket/jkms_s/
prop/filepath.info
```

It creates a custom song folder, writes chart XML files, installs audio banks, patches jacket/title assets, and registers the song in `music_list.xml`.

## Backups

The tool creates `.op3-mapper.bak` backups for key files when possible.

Still, keep your own clean copy of the game folder. This is a prototype patcher, and manual backups are wise.

## Removing Songs

The Web UI and CLI remove flow is intended for custom `M_CUSTOM...` songs only.

Do not use it to remove official songs.

