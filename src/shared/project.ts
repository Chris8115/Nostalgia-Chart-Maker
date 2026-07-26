export type Op3Difficulty = "normal" | "hard" | "expert" | "real";
export type Op3Hand = "left" | "right" | "both";
export type Op3NoteType = "tap" | "hold" | "trill";

export type Op3Note = {
  id: string;
  startMs: number;
  endMs: number;
  hand: Op3Hand;
  minKey: number;
  maxKey: number;
  pitch: number;
  type: Op3NoteType;
};

export type Op3Chart = {
  difficulty: Op3Difficulty;
  level: number;
  notes: Op3Note[];
};

export type Op3SongProject = {
  format: "op3song";
  formatVersion: 1;
  id: string;
  title: string;
  artist: string;
  description?: string;
  categoryFlag?: number;
  primaryCategory?: number;
  bpm: number;
  offsetMs: number;
  durationMs: number;
  audioPath?: string;
  jacketPath?: string;
  charts: Record<Op3Difficulty, Op3Chart>;
};

export const difficulties: Op3Difficulty[] = ["normal", "hard", "expert", "real"];
export const defaultDescription = "Community custom chart";
export const categoryOptions = [
  { label: "Classic", categoryFlag: 2, primaryCategory: 1 },
  { label: "Pop", categoryFlag: 4, primaryCategory: 2 },
  { label: "Anime", categoryFlag: 8, primaryCategory: 3 },
  { label: "Touhou / Internet", categoryFlag: 16, primaryCategory: 4 },
  { label: "BEMANI", categoryFlag: 32, primaryCategory: 5 },
  { label: "Nostalgia Original", categoryFlag: 64, primaryCategory: 6 }
] as const;

export function createEmptyProject(): Op3SongProject {
  return {
    format: "op3song",
    formatVersion: 1,
    id: "M_CUSTOM0001_NEWSONG",
    title: "New Song",
    artist: "Unknown Artist",
    description: defaultDescription,
    categoryFlag: 64,
    primaryCategory: 6,
    bpm: 120,
    offsetMs: 0,
    durationMs: 120000,
    charts: {
      normal: { difficulty: "normal", level: 4, notes: [] },
      hard: { difficulty: "hard", level: 7, notes: [] },
      expert: { difficulty: "expert", level: 10, notes: [] },
      real: { difficulty: "real", level: 13, notes: [] }
    }
  };
}

export function keyWidth(note: Pick<Op3Note, "minKey" | "maxKey">): number {
  return note.maxKey - note.minKey + 1;
}

export function notesOverlap(a: Op3Note, b: Op3Note): boolean {
  return (
    a.id !== b.id &&
    a.startMs < b.endMs &&
    a.endMs > b.startMs &&
    a.minKey <= b.maxKey &&
    a.maxKey >= b.minKey
  );
}

export type ValidationIssue = {
  severity: "error" | "warning";
  message: string;
  difficulty?: Op3Difficulty;
  noteId?: string;
};

export function validateProject(project: Op3SongProject): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!project.title.trim()) issues.push({ severity: "error", message: "Title is required." });
  if (!project.artist.trim()) issues.push({ severity: "warning", message: "Artist is empty." });
  if (!Number.isFinite(project.bpm) || project.bpm <= 0) issues.push({ severity: "error", message: "BPM must be positive." });

  for (const difficulty of difficulties) {
    const chart = project.charts[difficulty];
    for (const note of chart.notes) {
      if (note.minKey < 0 || note.maxKey > 27 || note.minKey > note.maxKey) {
        issues.push({ severity: "error", difficulty, noteId: note.id, message: "Note key range is outside 0-27." });
      }
      if (note.endMs <= note.startMs) {
        issues.push({ severity: "error", difficulty, noteId: note.id, message: "Note end must be after start." });
      }
      if (note.type === "tap" && note.endMs - note.startMs > 500) {
        issues.push({ severity: "warning", difficulty, noteId: note.id, message: "Tap note has a long duration." });
      }
    }

    const composites = chart.notes.filter((note) => note.type === "hold" || note.type === "trill");
    const nonHolds = chart.notes.filter((note) => note.type !== "hold");
    for (const note of nonHolds) {
      if (composites.some((composite) => composite.id !== note.id && notesOverlap(note, composite))) {
        issues.push({ severity: "error", difficulty, noteId: note.id, message: "Note overlaps an active hold/trill." });
      }
    }
    for (let i = 0; i < composites.length; i++) {
      for (let j = i + 1; j < composites.length; j++) {
        if (notesOverlap(composites[i], composites[j])) {
          issues.push({ severity: "error", difficulty, noteId: composites[j].id, message: "Hold/trill overlaps another hold/trill." });
        }
      }
    }
  }

  return issues;
}
