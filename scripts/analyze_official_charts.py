import argparse
import json
import statistics
import xml.etree.ElementTree as ET
from pathlib import Path


DIFFICULTY_NAMES = {
    "00normal": "normal",
    "01hard": "hard",
    "02extreme": "expert",
    "03real": "real",
}


def main():
    parser = argparse.ArgumentParser(description="Summarize official Nostalgia OP3 chart style metrics.")
    parser.add_argument("game_dir", help="Game directory containing data_op3/sound/music.")
    parser.add_argument("--limit", type=int, default=0, help="Optional max charts per difficulty.")
    parser.add_argument("--output", help="Optional JSON output path.")
    args = parser.parse_args()

    music_root = Path(args.game_dir) / "data_op3" / "sound" / "music"
    if not music_root.exists():
        raise SystemExit(f"Music folder was not found: {music_root}")

    rows = []
    for xml_path in sorted(music_root.glob("*/*.xml")):
        difficulty = difficulty_from_name(xml_path.name)
        if difficulty is None:
            continue
        if args.limit and sum(1 for row in rows if row["difficulty"] == difficulty) >= args.limit:
            continue
        metrics = analyze_chart(xml_path, difficulty)
        if metrics:
            rows.append(metrics)

    summary = summarize(rows)
    if args.output:
        Path(args.output).write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print_human(summary)


def difficulty_from_name(name: str):
    lowered = name.lower()
    for token, difficulty in DIFFICULTY_NAMES.items():
        if token in lowered:
            return difficulty
    return None


def analyze_chart(path: Path, difficulty: str):
    root = ET.parse(path).getroot()
    finish = int(read_text(root.find("./header/music_finish_time_msec"), "0"))
    notes = []
    for node in root.findall("./note_data/note"):
        start = int(read_text(node.find("start_timing_msec"), "0"))
        end = int(read_text(node.find("end_timing_msec"), str(start)))
        min_key = int(read_text(node.find("min_key_index"), "0"))
        max_key = int(read_text(node.find("max_key_index"), str(min_key)))
        note_type = int(read_text(node.find("note_type"), "0"))
        hand = int(read_text(node.find("hand"), "-1"))
        notes.append({
            "start": start,
            "end": end,
            "duration": max(0, end - start),
            "minKey": min_key,
            "maxKey": max_key,
            "width": max_key - min_key + 1,
            "type": note_type,
            "hand": hand,
        })
    if not notes:
        return None

    starts = sorted(note["start"] for note in notes)
    gaps = [b - a for a, b in zip(starts, starts[1:]) if b > a]
    duration_min = max(0.01, finish / 60000)
    long_notes = [note for note in notes if note["duration"] >= 450 or note["type"] != 0]
    left = sum(1 for note in notes if note["hand"] == 1)
    right = sum(1 for note in notes if note["hand"] == 0)
    simultaneous = count_simultaneous(starts)
    return {
        "song": path.parent.name,
        "difficulty": difficulty,
        "durationMs": finish,
        "notes": len(notes),
        "notesPerMinute": len(notes) / duration_min,
        "medianGapMs": median(gaps),
        "p10GapMs": percentile(gaps, 0.10),
        "medianWidth": median([note["width"] for note in notes]),
        "longRatio": len(long_notes) / len(notes),
        "leftRatio": left / max(1, left + right),
        "simultaneousRatio": simultaneous / len(notes),
        "keyMin": min(note["minKey"] for note in notes),
        "keyMax": max(note["maxKey"] for note in notes),
    }


def count_simultaneous(starts):
    counts = {}
    for start in starts:
        bucket = round(start / 24) * 24
        counts[bucket] = counts.get(bucket, 0) + 1
    return sum(count for count in counts.values() if count > 1)


def summarize(rows):
    grouped = {}
    for row in rows:
        grouped.setdefault(row["difficulty"], []).append(row)
    return {
        difficulty: {
            "charts": len(items),
            "notesPerMinute": describe([item["notesPerMinute"] for item in items]),
            "notes": describe([item["notes"] for item in items]),
            "medianGapMs": describe([item["medianGapMs"] for item in items]),
            "p10GapMs": describe([item["p10GapMs"] for item in items]),
            "medianWidth": describe([item["medianWidth"] for item in items]),
            "longRatio": describe([item["longRatio"] for item in items]),
            "leftRatio": describe([item["leftRatio"] for item in items]),
            "simultaneousRatio": describe([item["simultaneousRatio"] for item in items]),
            "keyMin": describe([item["keyMin"] for item in items]),
            "keyMax": describe([item["keyMax"] for item in items]),
        }
        for difficulty, items in grouped.items()
    }


def describe(values):
    clean = [float(value) for value in values if value is not None]
    if not clean:
        return None
    return {
        "p10": round(percentile(clean, 0.10), 3),
        "median": round(median(clean), 3),
        "p90": round(percentile(clean, 0.90), 3),
    }


def print_human(summary):
    for difficulty in ["normal", "hard", "expert", "real"]:
        item = summary.get(difficulty)
        if not item:
            continue
        npm = item["notesPerMinute"]
        notes = item["notes"]
        gap = item["medianGapMs"]
        width = item["medianWidth"]
        longs = item["longRatio"]
        print(
            f"{difficulty}: charts={item['charts']} "
            f"notes={notes['median']:.0f} npm={npm['median']:.0f} "
            f"gap={gap['median']:.0f}ms width={width['median']:.1f} "
            f"longs={longs['median'] * 100:.1f}%"
        )


def read_text(node, fallback):
    return node.text.strip() if node is not None and node.text else fallback


def median(values):
    clean = [value for value in values if value is not None]
    return statistics.median(clean) if clean else 0


def percentile(values, amount):
    clean = sorted(value for value in values if value is not None)
    if not clean:
        return 0
    position = (len(clean) - 1) * amount
    low = int(position)
    high = min(len(clean) - 1, low + 1)
    mix = position - low
    return clean[low] * (1 - mix) + clean[high] * mix


if __name__ == "__main__":
    main()
