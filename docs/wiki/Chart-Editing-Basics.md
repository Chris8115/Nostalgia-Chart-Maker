# Chart Editing Basics

Nostalgia Chart Maker stores one chart per difficulty:

- Normal
- Hard
- Expert
- Real

## Keyboard Range

Notes use the OP3 keyboard range:

```text
0-27
```

The lower keys are on the left side of the keyboard. Higher keys are on the right side.

## Note Types

Supported editor note types:

- Tap
- Hold
- Trill

## BPM

BPM controls beat guides, snapping, and generation timing.

If BPM is wrong, the beat grid will drift and generated notes will feel off even if individual notes look close.

## Offset

Offset is the first-beat timing in milliseconds.

Use it to line up the visible beat grid with the song. The editor can shift notes when offset changes so you can adjust alignment without regenerating.

## Validation

The validator tries to prevent unsafe overlaps:

- taps under holds/trills
- holds overlapping other holds/trills
- notes outside key range
- notes with invalid timing

Fix validation errors before installing into the game.

