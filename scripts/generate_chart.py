import argparse
import json
import math
import subprocess
import tempfile
import wave
from pathlib import Path

import numpy as np


PROFILES = {
    "normal": {"level": 4, "grid": 4, "width": 5, "npm": (220, 350), "bar": 8, "gap": 0.24},
    "hard": {"level": 7, "grid": 6, "width": 4, "npm": (310, 470), "bar": 13, "gap": 0.14},
    "expert": {"level": 10, "grid": 8, "width": 3, "npm": (455, 660), "bar": 18, "gap": 0.10},
    "real": {"level": 13, "grid": 12, "width": 3, "npm": (575, 820), "bar": 24, "gap": 0.07},
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--ffmpeg", required=True)
    args = parser.parse_args()

    payload = json.loads(Path(args.input).read_text(encoding="utf-8-sig"))
    project = payload["project"]
    options = payload.get("options", {})
    audio_path = Path(payload["audioPath"])
    midi_path = Path(payload["midiPath"]) if payload.get("midiPath") else None

    samples, sample_rate = decode_audio(Path(args.ffmpeg), audio_path)
    analysis = analyze(samples, sample_rate)
    midi_events = parse_midi(midi_path) if midi_path and midi_path.exists() else None
    duration_ms = round(len(samples) / sample_rate * 1000)
    project["durationMs"] = duration_ms

    density = clamp(float(options.get("density", 0.55)), 0.15, 1.25)
    sensitivity = clamp(float(options.get("sensitivity", 0.72)), 0.15, 1.25)
    bpm = max(1.0, float(project.get("bpm", 120)))
    offset_ms = max(0, int(project.get("offsetMs", 0)))

    charts = dict(project.get("charts", {}))
    for difficulty, profile in PROFILES.items():
        notes = generate_from_midi(midi_events, duration_ms, profile, difficulty, density, sensitivity, bpm) if midi_events else generate_notes(analysis, duration_ms, bpm, offset_ms, profile, difficulty, density, sensitivity)
        charts[difficulty] = {
            "difficulty": difficulty,
            "level": charts.get(difficulty, {}).get("level", profile["level"]),
            "notes": notes,
        }
    project["charts"] = charts
    Path(args.output).write_text(json.dumps(project, indent=2) + "\n", encoding="utf-8")


def decode_audio(ffmpeg: Path, audio_path: Path):
    wav_path = Path(tempfile.gettempdir()) / f"op3_mapper_{abs(hash(str(audio_path)))}.wav"
    subprocess.run(
        [str(ffmpeg), "-y", "-i", str(audio_path), "-ac", "1", "-ar", "22050", str(wav_path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=True,
    )
    with wave.open(str(wav_path), "rb") as handle:
        sample_rate = handle.getframerate()
        data = handle.readframes(handle.getnframes())
    samples = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
    return samples, sample_rate


def analyze(samples: np.ndarray, sample_rate: int):
    frame = 2048
    hop = 512
    starts = np.arange(0, max(1, len(samples) - frame), hop)
    window = np.hanning(frame).astype(np.float32)
    midi_values = np.arange(36, 85)
    freqs = 440.0 * (2.0 ** ((midi_values - 69) / 12.0))
    fft_freqs = np.fft.rfftfreq(frame, 1 / sample_rate)

    spectra = []
    rms = []
    for start in starts:
        chunk = samples[start:start + frame]
        if len(chunk) < frame:
            chunk = np.pad(chunk, (0, frame - len(chunk)))
        chunk = chunk * window
        mag = np.abs(np.fft.rfft(chunk))
        spectra.append(mag)
        rms.append(float(np.sqrt(np.mean(chunk * chunk))))
    spectra = np.asarray(spectra, dtype=np.float32)
    rms = normalize(np.asarray(rms, dtype=np.float32))

    salience = np.zeros((len(starts), len(midi_values)), dtype=np.float32)
    for idx, freq in enumerate(freqs):
        bandwidth = max(18.0, freq * 0.045)
        weights = np.maximum(0, 1 - np.abs(fft_freqs - freq) / bandwidth)
        if weights.sum() <= 0:
            continue
        harmonic = weights
        if freq * 2 < sample_rate / 2:
            harmonic = harmonic + 0.45 * np.maximum(0, 1 - np.abs(fft_freqs - freq * 2) / (bandwidth * 1.4))
        if freq * 3 < sample_rate / 2:
            harmonic = harmonic + 0.22 * np.maximum(0, 1 - np.abs(fft_freqs - freq * 3) / (bandwidth * 1.8))
        salience[:, idx] = spectra @ (harmonic / max(1e-6, harmonic.sum()))

    salience = normalize_2d(salience)
    flux = np.maximum(0, salience[1:] - salience[:-1]).sum(axis=1)
    flux = np.r_[flux[0] if len(flux) else 0, flux]
    onset = normalize(flux * 0.78 + rms * 0.22)
    melody_idx = track_melody(salience, rms)
    melody_midi = midi_values[melody_idx]
    confidence = salience[np.arange(len(salience)), melody_idx]
    bass_idx = np.argmax(salience[:, :18], axis=1)
    bass_midi = midi_values[bass_idx]
    times_ms = starts / sample_rate * 1000.0
    return {
        "times": times_ms,
        "onset": onset,
        "energy": rms,
        "salience": salience,
        "midi_values": midi_values,
        "melody_midi": smooth_series(melody_midi.astype(np.float32), 9),
        "melody_confidence": smooth_series(confidence.astype(np.float32), 5),
        "bass_midi": smooth_series(bass_midi.astype(np.float32), 9),
    }


def track_melody(salience: np.ndarray, energy: np.ndarray):
    frames, bins = salience.shape
    if frames == 0:
        return np.zeros(0, dtype=np.int32)
    dp = np.zeros((frames, bins), dtype=np.float32)
    back = np.zeros((frames, bins), dtype=np.int16)
    dp[0] = salience[0]
    for t in range(1, frames):
        for b in range(bins):
            jump = np.abs(np.arange(bins) - b)
            penalty = jump * 0.055 + np.maximum(0, jump - 7) * 0.11
            scores = dp[t - 1] - penalty
            prev = int(np.argmax(scores))
            dp[t, b] = scores[prev] + salience[t, b] * (0.72 + energy[t] * 0.28)
            back[t, b] = prev
    path = np.zeros(frames, dtype=np.int32)
    path[-1] = int(np.argmax(dp[-1]))
    for t in range(frames - 2, -1, -1):
        path[t] = back[t + 1, path[t + 1]]
    return path


def generate_notes(analysis, duration_ms, bpm, offset_ms, profile, difficulty, density, sensitivity):
    beat_ms = 60000.0 / bpm
    step_ms = beat_ms / profile["grid"]
    target = target_count(duration_ms, profile, density, sensitivity)
    max_bar = round(profile["bar"] * (0.92 + density * 0.32))
    min_gap = beat_ms * profile["gap"]
    hits = build_hits(analysis, duration_ms, offset_ms, beat_ms, step_ms, profile)
    if not hits:
        return []

    scores = np.asarray([hit["score"] for hit in hits])
    floor = float(np.quantile(scores, clamp(0.58 - sensitivity * 0.20 - density * 0.08, 0.18, 0.62)))
    selected = []
    per_bar = {}
    for hit in sorted(hits, key=lambda item: item["score"], reverse=True):
        if len(selected) >= target:
            break
        if per_bar.get(hit["bar"], 0) >= max_bar:
            continue
        collision = next((other for other in selected if abs(other["time"] - hit["time"]) < min_gap), None)
        if collision and hit["score"] < collision["score"] + 0.05:
            continue
        if hit["score"] < floor and not hit["metric"]:
            continue
        selected.append(hit)
        per_bar[hit["bar"]] = per_bar.get(hit["bar"], 0) + 1

    selected.sort(key=lambda item: item["time"])
    notes = arrange_selected(selected, analysis, profile, difficulty, beat_ms)
    return legalize(notes, beat_ms, difficulty)


def build_hits(analysis, duration_ms, offset_ms, beat_ms, step_ms, profile):
    times = analysis["times"]
    onset = analysis["onset"]
    energy = analysis["energy"]
    melody = analysis["melody_midi"]
    confidence = analysis["melody_confidence"]
    hits = []
    steps_per_bar = profile["grid"] * 4
    radius = max(35.0, min(95.0, step_ms * 0.62))
    step = 0
    time_ms = float(offset_ms)
    while time_ms < duration_ms - beat_ms * 0.25:
        idx = nearest_peak(times, onset * 0.78 + energy * 0.22, time_ms, radius)
        slot = step % steps_per_bar
        on_beat = slot % profile["grid"] == 0
        half_beat = slot % max(1, round(profile["grid"] / 2)) == 0
        downbeat = slot == 0
        metric = downbeat or on_beat or (profile["grid"] > 4 and half_beat)
        previous = max(0, idx - 8)
        motion = min(1.0, abs(float(melody[idx]) - float(melody[previous])) / 12.0)
        local_peak = local_extreme(melody, idx)
        note_time = time_ms + clamp(float(times[idx] - time_ms), -step_ms * 0.34, step_ms * 0.34) * 0.65
        score = (
            float(onset[idx]) * 0.84
            + float(energy[idx]) * 0.18
            + float(confidence[idx]) * 0.24
            + motion * 0.24
            + (0.18 if local_peak else 0)
            + (0.28 if downbeat else 0.18 if on_beat else 0.08 if half_beat else 0)
        )
        if score > 0.15:
            hits.append({
                "step": step,
                "time": int(round(note_time)),
                "grid": int(round(time_ms)),
                "idx": idx,
                "bar": step // steps_per_bar,
                "score": score,
                "metric": metric,
                "downbeat": downbeat,
                "onBeat": on_beat,
                "melody": float(melody[idx]),
                "confidence": float(confidence[idx]),
                "motion": motion,
                "extreme": local_peak,
            })
        step += 1
        time_ms += step_ms
    return hits


def arrange_selected(selected, analysis, profile, difficulty, beat_ms):
    notes = []
    melody = analysis["melody_midi"]
    bass = analysis["bass_midi"]
    melody_values = [hit["melody"] for hit in selected if hit["confidence"] > 0.16]
    low = np.quantile(melody_values, 0.05) if melody_values else 48
    high = np.quantile(melody_values, 0.95) if melody_values else 84
    last_right = -10**9
    last_left = -10**9
    previous_right = None
    previous_left = None

    for hit in selected:
        melody_like = hit["confidence"] > 0.20 or hit["motion"] > 0.10 or hit["extreme"] != 0
        use_right = melody_like or (hit["time"] - last_right > hit["time"] - last_left and not hit["downbeat"])
        hand = "right" if use_right else "left"
        if hand == "right":
            norm = clamp((hit["melody"] - low) / max(8.0, high - low), 0.0, 1.0)
            if hit["extreme"] > 0:
                norm = clamp(norm + 0.12, 0, 1)
            elif hit["extreme"] < 0:
                norm = clamp(norm - 0.12, 0, 1)
            center = round(14 + norm * 11)
            pitch = int(round(50 + norm * 34))
            if previous_right is not None and abs(center - previous_right) < 2 and hit["motion"] > 0.08:
                center += 2 if hit["melody"] >= previous_right else -2
            previous_right = center
            last_right = hit["time"]
        else:
            bass_midi = float(bass[hit["idx"]])
            norm = clamp((bass_midi - 36) / 24.0, 0.0, 1.0)
            center = round(4 + norm * 9)
            pitch = int(round(32 + norm * 25))
            previous_left = center
            last_left = hit["time"]

        width = profile["width"]
        duration = max(115, beat_ms * (0.30 if difficulty == "normal" else 0.22))
        notes.append(make_note(f"{difficulty}-{hit['step']}-{hand}", hit["time"], duration, hand, width, center, pitch))

        if hit["downbeat"] and difficulty != "normal" and hit["score"] > 0.95:
            other = "left" if hand == "right" else "right"
            if other == "left" and hit["time"] - last_left > beat_ms * 0.18:
                bass_midi = float(bass[hit["idx"]])
                norm = clamp((bass_midi - 36) / 24.0, 0.0, 1.0)
                notes.append(make_note(f"{difficulty}-{hit['step']}-left-pair", hit["time"], beat_ms * 0.18, "left", width, round(4 + norm * 9), int(round(32 + norm * 25))))
                last_left = hit["time"]
    return notes


def generate_from_midi(events, duration_ms, profile, difficulty, density, sensitivity, bpm):
    target = target_count(duration_ms, profile, density, sensitivity)
    max_bar = round(profile["bar"] * (0.92 + density * 0.32))
    bucket_ms = 240 if difficulty == "normal" else 160 if difficulty == "hard" else 115 if difficulty == "expert" else 85
    min_gap = 170 if difficulty == "normal" else 95 if difficulty == "hard" else 70
    usable = [event for event in events if event["duration"] >= 35 and event["velocity"] >= 8]
    if not usable:
        return []

    groups = group_midi_events(usable, bucket_ms)
    ranked = []
    for group in groups:
        notes = group["notes"]
        melody = max(notes, key=lambda event: (event["pitch"], event["velocity"]))
        bass = min(notes, key=lambda event: (event["pitch"], -event["velocity"]))
        spread = melody["pitch"] - bass["pitch"]
        score = (
            max(event["velocity"] for event in notes) / 127.0 * 0.46
            + min(1.0, len(notes) / 4.0) * 0.22
            + min(1.0, spread / 24.0) * 0.18
            + (0.18 if melody["duration"] > 450 else 0)
        )
        ranked.append({**group, "melody": melody, "bass": bass, "score": score})

    selected = []
    per_bar = {}
    for group in sorted(ranked, key=lambda item: item["score"], reverse=True):
        if len(selected) >= target:
            break
        bar = int(group["time"] // 2000)
        if per_bar.get(bar, 0) >= max_bar:
            continue
        if any(abs(other["time"] - group["time"]) < min_gap for other in selected):
            continue
        selected.append(group)
        per_bar[bar] = per_bar.get(bar, 0) + 1

    selected.sort(key=lambda item: item["time"])
    pitches = [group["melody"]["pitch"] for group in selected]
    low = np.quantile(pitches, 0.05) if pitches else 48
    high = np.quantile(pitches, 0.95) if pitches else 84
    notes = []
    for group in selected:
        melody = group["melody"]
        norm = clamp((melody["pitch"] - low) / max(8.0, high - low), 0.0, 1.0)
        center = round(14 + norm * 11)
        duration = min(max(melody["duration"], 120), 1800)
        if duration < 520:
            duration = 140
        notes.append(make_note(f"{difficulty}-midi-{group['index']}-right", group["time"], duration, "right", profile["width"], center, melody["pitch"]))

        bass = group["bass"]
        if bass["pitch"] < melody["pitch"] - 7 and (difficulty != "normal" or group["score"] > 0.72):
            bass_norm = clamp((bass["pitch"] - 30) / 32.0, 0.0, 1.0)
            bass_center = round(4 + bass_norm * 9)
            notes.append(make_note(f"{difficulty}-midi-{group['index']}-left", group["time"], 140, "left", profile["width"], bass_center, bass["pitch"]))

    return legalize(notes, 60000 / max(1.0, bpm), difficulty)


def group_midi_events(events, bucket_ms):
    groups = []
    current = None
    for index, event in enumerate(sorted(events, key=lambda item: (item["start"], item["pitch"]))):
        bucket = round(event["start"] / bucket_ms) * bucket_ms
        if current is None or abs(bucket - current["time"]) > bucket_ms * 0.5:
            current = {"index": index, "time": int(bucket), "notes": [event]}
            groups.append(current)
        else:
            current["notes"].append(event)
    return groups


def parse_midi(path: Path):
    data = path.read_bytes()
    if data[:4] != b"MThd":
        raise RuntimeError(f"not a MIDI file: {path}")
    header_length = read_u32(data, 4)
    if header_length < 6:
        raise RuntimeError("invalid MIDI header")
    fmt = read_u16(data, 8)
    track_count = read_u16(data, 10)
    division = read_u16(data, 12)
    if division & 0x8000:
        raise RuntimeError("SMPTE-time MIDI files are not supported yet")

    cursor = 8 + header_length
    track_events = []
    tempo_events = [{"tick": 0, "tempo": 500000}]
    for track_index in range(track_count):
        if cursor + 8 > len(data) or data[cursor:cursor + 4] != b"MTrk":
            raise RuntimeError(f"missing MIDI track {track_index}")
        length = read_u32(data, cursor + 4)
        start = cursor + 8
        end = start + length
        events, tempos = parse_midi_track(data[start:end], track_index)
        track_events.extend(events)
        tempo_events.extend(tempos)
        cursor = end

    tempo_map = sorted(tempo_events, key=lambda item: item["tick"])
    notes = pair_midi_notes(track_events)
    converted = []
    for note in notes:
        start_ms = tick_to_ms(note["startTick"], tempo_map, division)
        end_ms = tick_to_ms(note["endTick"], tempo_map, division)
        duration = max(1, end_ms - start_ms)
        if duration < 25:
            continue
        converted.append({
            "start": int(round(start_ms)),
            "duration": int(round(duration)),
            "pitch": int(note["pitch"]),
            "velocity": int(note["velocity"]),
            "channel": int(note["channel"]),
            "track": int(note["track"]),
        })
    return sorted(converted, key=lambda item: (item["start"], item["pitch"]))


def parse_midi_track(track_data: bytes, track_index: int):
    cursor = 0
    tick = 0
    running_status = None
    events = []
    tempos = []
    while cursor < len(track_data):
        delta, cursor = read_varlen(track_data, cursor)
        tick += delta
        if cursor >= len(track_data):
            break
        status = track_data[cursor]
        if status < 0x80:
            if running_status is None:
                raise RuntimeError("MIDI running status appeared before a status byte")
            status = running_status
        else:
            cursor += 1
            if status < 0xF0:
                running_status = status

        if status == 0xFF:
            if cursor >= len(track_data):
                break
            meta_type = track_data[cursor]
            cursor += 1
            length, cursor = read_varlen(track_data, cursor)
            payload = track_data[cursor:cursor + length]
            cursor += length
            if meta_type == 0x51 and length == 3:
                tempos.append({"tick": tick, "tempo": int.from_bytes(payload, "big")})
            elif meta_type == 0x2F:
                break
            continue

        if status in (0xF0, 0xF7):
            length, cursor = read_varlen(track_data, cursor)
            cursor += length
            continue

        event_type = status & 0xF0
        channel = status & 0x0F
        data_len = 1 if event_type in (0xC0, 0xD0) else 2
        payload = track_data[cursor:cursor + data_len]
        cursor += data_len
        if len(payload) < data_len:
            break

        if event_type in (0x80, 0x90):
            pitch = payload[0]
            velocity = payload[1]
            kind = "off" if event_type == 0x80 or velocity == 0 else "on"
            events.append({
                "tick": tick,
                "kind": kind,
                "pitch": pitch,
                "velocity": velocity,
                "channel": channel,
                "track": track_index,
            })

    return events, tempos


def pair_midi_notes(events):
    active = {}
    notes = []
    for event in sorted(events, key=lambda item: (item["tick"], 0 if item["kind"] == "off" else 1)):
        key = (event["track"], event["channel"], event["pitch"])
        if event["kind"] == "on":
            active.setdefault(key, []).append(event)
            continue
        stack = active.get(key)
        if not stack:
            continue
        start = stack.pop(0)
        if event["tick"] <= start["tick"]:
            continue
        notes.append({
            "startTick": start["tick"],
            "endTick": event["tick"],
            "pitch": start["pitch"],
            "velocity": start["velocity"],
            "channel": start["channel"],
            "track": start["track"],
        })
    return notes


def tick_to_ms(tick, tempo_map, division):
    elapsed = 0.0
    previous_tick = 0
    tempo = 500000
    for entry in tempo_map:
        entry_tick = entry["tick"]
        if entry_tick > tick:
            break
        elapsed += (entry_tick - previous_tick) * tempo / division / 1000.0
        previous_tick = entry_tick
        tempo = entry["tempo"]
    elapsed += (tick - previous_tick) * tempo / division / 1000.0
    return elapsed


def read_varlen(data: bytes, cursor: int):
    value = 0
    for _ in range(4):
        if cursor >= len(data):
            raise RuntimeError("unterminated MIDI variable-length value")
        byte = data[cursor]
        cursor += 1
        value = (value << 7) | (byte & 0x7F)
        if not byte & 0x80:
            return value, cursor
    return value, cursor


def read_u16(data: bytes, offset: int):
    return int.from_bytes(data[offset:offset + 2], "big")


def read_u32(data: bytes, offset: int):
    return int.from_bytes(data[offset:offset + 4], "big")


def legalize(notes, beat_ms, difficulty):
    kept = []
    min_gap = beat_ms * (0.34 if difficulty == "normal" else 0.14 if difficulty == "hard" else 0.09)
    last = {"left": -10**9, "right": -10**9, "both": -10**9}
    for note in sorted(notes, key=lambda item: (item["startMs"], item["minKey"])):
        if note["startMs"] - last[note["hand"]] < min_gap:
            continue
        at_time = [other for other in kept if abs(other["startMs"] - note["startMs"]) <= 24]
        if len(at_time) >= (2 if difficulty == "normal" else 3):
            continue
        kept.append(note)
        last[note["hand"]] = note["startMs"]
    return kept


def make_note(note_id, start, duration, hand, width, center, pitch):
    min_key = int(clamp(round(center - (width - 1) // 2), 0, 27))
    max_key = int(clamp(min_key + width - 1, 0, 27))
    return {
        "id": note_id,
        "startMs": int(round(start)),
        "endMs": int(round(start + duration)),
        "hand": hand,
        "minKey": min_key,
        "maxKey": max_key,
        "pitch": int(round(pitch)),
        "type": "tap",
    }


def nearest_peak(times, scores, time_ms, radius_ms):
    center = int(np.searchsorted(times, time_ms))
    left = max(0, int(np.searchsorted(times, time_ms - radius_ms)))
    right = min(len(times) - 1, int(np.searchsorted(times, time_ms + radius_ms)))
    if right <= left:
        return min(len(times) - 1, max(0, center))
    local = scores[left:right + 1]
    return left + int(np.argmax(local))


def local_extreme(values, index):
    left = values[max(0, index - 8)]
    current = values[index]
    right = values[min(len(values) - 1, index + 8)]
    if current - left > 1.5 and current - right > 1.5:
        return 1
    if left - current > 1.5 and right - current > 1.5:
        return -1
    return 0


def target_count(duration_ms, profile, density, sensitivity):
    minutes = max(0.5, duration_ms / 60000)
    low, high = profile["npm"]
    mix = clamp(density * 0.72 + sensitivity * 0.28, 0, 1.15)
    return round(minutes * (low + (high - low) * mix))


def smooth_series(values, window):
    if len(values) == 0:
        return values
    radius = window // 2
    out = np.zeros_like(values, dtype=np.float32)
    for idx in range(len(values)):
        chunk = values[max(0, idx - radius): min(len(values), idx + radius + 1)]
        out[idx] = float(np.median(chunk))
    return out


def normalize(values):
    values = np.asarray(values, dtype=np.float32)
    if len(values) == 0:
        return values
    low = np.quantile(values, 0.08)
    high = np.quantile(values, 0.985)
    return np.clip((values - low) / max(1e-6, high - low), 0, 1)


def normalize_2d(values):
    low = np.quantile(values, 0.12)
    high = np.quantile(values, 0.995)
    return np.clip((values - low) / max(1e-6, high - low), 0, 1)


def clamp(value, low, high):
    return max(low, min(high, value))


if __name__ == "__main__":
    main()
