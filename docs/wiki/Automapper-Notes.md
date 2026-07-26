# Automapper Notes

The automapper is experimental.

Use it as a starting point, not as a finished chart author.

## MIDI-Assisted Generation

MIDI-assisted generation is the recommended path when you have a usable MIDI file.

The server-side generator parses:

- note start times
- durations
- pitches
- velocities
- tempo changes

This usually gives cleaner melody and rhythm structure than audio-only analysis.

## Audio-Only Generation

Audio-only generation analyzes waveform and spectral content.

It can find broad rhythm and melodic movement, but it is much less reliable than MIDI. Dense music, vocals, distortion, reverb, and percussion-heavy sections can confuse it.

## Density

Density controls how many note opportunities the generator tries to keep.

Lower density should produce simpler charts. Higher density should preserve more events for harder charts.

## Beat Sensitivity

Beat sensitivity controls how aggressively the generator reacts to audio events.

Too low can miss obvious notes. Too high can create noisy clutter.

## Practical Advice

- Set BPM and offset first.
- Use MIDI when possible.
- Generate one difficulty, review it, then adjust settings.
- Manually fix important musical moments.
- Keep Normal readable and use higher difficulties for extra detail.

