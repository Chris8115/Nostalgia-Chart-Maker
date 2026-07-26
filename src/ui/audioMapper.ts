import {
  Op3Difficulty,
  Op3Hand,
  Op3Note,
  Op3SongProject,
  notesOverlap
} from "../shared/project.js";

type AudioFrame = {
  timeMs: number;
  energy: number;
  onset: number;
  brightness: number;
  low: number;
  mid: number;
  high: number;
  spectralNorm: number;
  pitchMidi: number | null;
  pitchConfidence: number;
  melodyMidi: number | null;
};

export type AudioGuidePoint = {
  timeMs: number;
  energy: number;
  onset: number;
  brightness: number;
};

type DifficultyProfile = {
  difficulty: Op3Difficulty;
  level: number;
  grid: number;
  width: number;
  notesPerMinute: [number, number];
  maxPerBar: number;
  minGapBeats: number;
  chordDensity: number;
};

export type GenerateOptions = {
  density: number;
  trills?: boolean;
  sensitivity?: number;
};

export type BpmEstimate = {
  bpm: number;
  confidence: number;
  offsetMs: number;
  alternatives: Array<{ bpm: number; offsetMs: number; confidence: number }>;
};

type KeyProfile = {
  root: number;
  mode: "major" | "minor";
  allowed: number[];
};

type MelodyMap = {
  low: number;
  high: number;
  points: MelodyPoint[];
};

type MelodyPoint = {
  timeMs: number;
  midi: number | null;
  norm: number | null;
  confidence: number;
  motion: number;
  extreme: -1 | 0 | 1;
};

type GridHit = {
  step: number;
  timeMs: number;
  noteMs: number;
  peakMs: number;
  frame: AudioFrame;
  score: number;
  pulse: number;
  bar: number;
  slot: number;
  onBeat: boolean;
  halfBeat: boolean;
  downbeat: boolean;
  pitch: number | null;
  melodyNorm: number | null;
  melodyMotion: number;
  melodyConfidence: number;
  melodyExtreme: -1 | 0 | 1;
  spectralNorm: number;
};

const profiles: DifficultyProfile[] = [
  { difficulty: "normal", level: 4, grid: 4, width: 5, notesPerMinute: [220, 350], maxPerBar: 8, minGapBeats: 0.24, chordDensity: 0.86 },
  { difficulty: "hard", level: 7, grid: 6, width: 4, notesPerMinute: [310, 470], maxPerBar: 13, minGapBeats: 0.14, chordDensity: 0.48 },
  { difficulty: "expert", level: 10, grid: 8, width: 3, notesPerMinute: [455, 660], maxPerBar: 18, minGapBeats: 0.1, chordDensity: 0.32 },
  { difficulty: "real", level: 13, grid: 12, width: 3, notesPerMinute: [575, 820], maxPerBar: 24, minGapBeats: 0.07, chordDensity: 0.26 }
];

export async function generateProjectFromAudio(file: File, project: Op3SongProject, options: GenerateOptions = { density: 0.55, trills: true, sensitivity: 0.72 }): Promise<Op3SongProject> {
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    const frames = analyzeBuffer(buffer);
    const key = detectKey(frames);
    const next: Op3SongProject = {
      ...project,
      durationMs: Math.round(buffer.duration * 1000),
      audioPath: project.audioPath || file.name,
      charts: { ...project.charts }
    };

    for (const profile of profiles) {
      next.charts[profile.difficulty] = {
        difficulty: profile.difficulty,
        level: profile.level,
        notes: generateChart(frames, next, profile, key, options)
      };
    }

    return next;
  } finally {
    await context.close();
  }
}

export async function estimateBpmFromAudio(file: File): Promise<BpmEstimate | null> {
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    return estimateBpm(analyzeRhythmBuffer(buffer));
  } finally {
    await context.close();
  }
}

export async function analyzeAudioGuideFromAudio(file: File): Promise<AudioGuidePoint[]> {
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    return compressAudioGuide(analyzeRhythmBuffer(buffer), 2600);
  } finally {
    await context.close();
  }
}

export async function renderProjectPitchesFromAudio(file: File, project: Op3SongProject): Promise<Op3SongProject> {
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    const frames = analyzeBuffer(buffer);
    const key = detectKey(frames);
    return {
      ...project,
      durationMs: Math.round(buffer.duration * 1000),
      charts: Object.fromEntries(Object.entries(project.charts).map(([difficulty, chart]) => [
        difficulty,
        { ...chart, notes: legalizeNotes(renderNotePitches(chart.notes, frames, key), 60000 / Math.max(1, project.bpm), chart.difficulty) }
      ])) as Op3SongProject["charts"]
    };
  } finally {
    await context.close();
  }
}

function generateChart(frames: AudioFrame[], project: Op3SongProject, profile: DifficultyProfile, key: KeyProfile, options: GenerateOptions): Op3Note[] {
  const beatMs = 60000 / Math.max(1, project.bpm);
  const stepMs = beatMs / profile.grid;
  const startMs = Math.max(0, Math.round(project.offsetMs));
  const endMs = Math.max(startMs, project.durationMs - beatMs * 0.25);
  const density = clamp(options.density, 0.15, 1.25);
  const sensitivity = clamp(options.sensitivity ?? 0.72, 0.15, 1.25);
  const melody = buildMelodyMap(frames);
  const target = targetNoteCount(project.durationMs, profile, density, sensitivity);
  const grid = buildGridHits(frames, profile, beatMs, stepMs, startMs, endMs);
  const selected = selectHits(grid, profile, beatMs, density, sensitivity, target);
  const notes = arrangeHits(selected, frames, profile, key, melody, beatMs, density, options.trills !== false);
  return legalizeNotes(renderNotePitches(notes, frames, key), beatMs, profile.difficulty);
}

function buildGridHits(frames: AudioFrame[], profile: DifficultyProfile, beatMs: number, stepMs: number, startMs: number, endMs: number): GridHit[] {
  const radiusMs = Math.max(34, Math.min(90, stepMs * 0.58));
  const stepsPerBar = profile.grid * 4;
  const melody = buildMelodyMap(frames);
  const hits: GridHit[] = [];

  for (let step = 0, timeMs = startMs; timeMs < endMs; step++, timeMs += stepMs) {
    const peak = peakFrameAround(frames, timeMs, radiusMs);
    const pulse = localPulse(frames, timeMs, radiusMs);
    if (peak.energy < 0.07 && pulse < 0.1) continue;

    const slot = positiveModulo(step, stepsPerBar);
    const onBeat = slot % profile.grid === 0;
    const halfBeat = slot % Math.max(1, Math.round(profile.grid / 2)) === 0;
    const downbeat = slot === 0;
    const phrase = positiveModulo(step, stepsPerBar * 4) === 0 || positiveModulo(step, stepsPerBar * 4) === stepsPerBar * 2;
    const distance = Math.abs(peak.timeMs - timeMs) / radiusMs;
    const melodyPoint = melodyPointAt(melody, peak.timeMs);
    const spectralMotion = Math.abs(peak.spectralNorm - frameAt(frames, peak.timeMs - 180).spectralNorm);
    const motion = Math.max(melodyMotion(frames, peak.timeMs), melodyPoint.motion, spectralMotion);
    const melodyTurn = melodyPoint.confidence > 0.24
      ? melodyPoint.motion * 0.26 + (melodyPoint.extreme === 0 ? 0 : 0.18)
      : 0;
    const metric = downbeat ? 0.34 : onBeat ? 0.22 : halfBeat ? 0.1 : 0;
    const score = clamp(
      pulse * 0.72 +
      peak.onset * 0.38 +
      peak.energy * 0.22 +
      peak.brightness * 0.1 +
      motion * 0.18 +
      melodyTurn +
      metric +
      (phrase ? 0.1 : 0) -
      distance * 0.16,
      0,
      2
    );

    hits.push({
      step,
      timeMs: Math.round(timeMs),
      noteMs: Math.round(timeMs + clamp(peak.timeMs - timeMs, -stepMs * 0.32, stepMs * 0.32) * 0.62),
      peakMs: peak.timeMs,
      frame: peak,
      score,
      pulse,
      bar: Math.floor(step / stepsPerBar),
      slot,
      onBeat,
      halfBeat,
      downbeat,
      pitch: melodyPoint.midi ?? nearestReliablePitch(peak, frames),
      melodyNorm: melodyPoint.norm,
      melodyMotion: melodyPoint.motion,
      melodyConfidence: melodyPoint.confidence,
      melodyExtreme: melodyPoint.extreme,
      spectralNorm: peak.spectralNorm
    });
  }

  return hits;
}

function selectHits(hits: GridHit[], profile: DifficultyProfile, beatMs: number, density: number, sensitivity: number, targetNotes: number): GridHit[] {
  if (hits.length === 0) return [];

  const scores = hits.map((hit) => hit.score);
  const floor = percentile(scores, clamp(0.68 - sensitivity * 0.24 - density * 0.1, 0.26, 0.72));
  const targetHits = Math.max(8, Math.round(targetNotes / (1.02 + density * profile.chordDensity * 0.14)));
  const maxBar = Math.max(2, Math.round(profile.maxPerBar * (0.86 + density * 0.34)));
  const minGapMs = beatMs * profile.minGapBeats;
  const selected: GridHit[] = [];
  const perBar = new Map<number, number>();

  const ranked = [...hits]
    .filter((hit) => (
      hit.score >= floor ||
      (hit.onBeat && hit.pulse > floor * 0.72) ||
      (hit.melodyConfidence > 0.3 && (hit.melodyMotion > 0.12 || hit.melodyExtreme !== 0))
    ))
    .sort((a, b) => b.score - a.score || a.timeMs - b.timeMs);

  for (const hit of ranked) {
    if (selected.length >= targetHits) break;
    if ((perBar.get(hit.bar) ?? 0) >= maxBar) continue;
    const collision = selected.find((other) => Math.abs(other.noteMs - hit.noteMs) < minGapMs);
    if (collision && hit.score < collision.score + 0.08) continue;
    selected.push(hit);
    perBar.set(hit.bar, (perBar.get(hit.bar) ?? 0) + 1);
  }

  const backfill = hits.filter((candidate) => (
    (candidate.onBeat || (profile.difficulty !== "normal" && candidate.halfBeat)) &&
    (
      candidate.pulse > floor * 0.5 ||
      candidate.score > floor * 0.72 ||
      (candidate.melodyConfidence > 0.26 && candidate.melodyMotion > 0.1)
    )
  )).sort((a, b) => a.timeMs - b.timeMs);
  for (const hit of backfill) {
    if (selected.length >= targetHits) break;
    if ((perBar.get(hit.bar) ?? 0) >= maxBar) continue;
    if (selected.some((other) => Math.abs(other.noteMs - hit.noteMs) < beatMs * (profile.difficulty === "normal" ? 0.42 : 0.18))) continue;
    selected.push(hit);
    perBar.set(hit.bar, (perBar.get(hit.bar) ?? 0) + 1);
  }

  return selected.sort((a, b) => a.noteMs - b.noteMs);
}

function arrangeHits(hits: GridHit[], frames: AudioFrame[], profile: DifficultyProfile, key: KeyProfile, melody: MelodyMap, beatMs: number, density: number, allowTrills: boolean): Op3Note[] {
  const notes: Op3Note[] = [];
  const previousPitch: Record<Op3Hand, number | null> = { left: null, right: null, both: null };
  const lastHandMs: Record<Op3Hand, number> = { left: -Infinity, right: -Infinity, both: -Infinity };
  const trillRanges = allowTrills ? findTrillRanges(hits, profile, beatMs, density) : [];

  for (let index = 0; index < hits.length; index++) {
    const hit = hits[index];
    const trillRange = trillRanges.find((range) => range.start === index);
    if (trillRanges.some((range) => index > range.start && index <= range.end)) continue;
    if (trillRange) {
      notes.push(makeTrill(hits.slice(trillRange.start, trillRange.end + 1), profile, key, melody));
      continue;
    }

    const hand = chooseHandForHit(hit, profile, lastHandMs);
    const rawPitch = pitchForHit(hit, hand, frames, key, melody);
    const pitch = smoothPitch(rawPitch, previousPitch[hand], hand, key);
    const holdBeats = holdLengthBeats(hit, hits[index + 1], frames, profile, beatMs);
    const durationMs = holdBeats > 0 ? holdBeats * beatMs : Math.max(115, beatMs * (profile.difficulty === "normal" ? 0.3 : 0.23));

    const note = makeNote(`${profile.difficulty}-${hit.step}-${hand}`, hit.noteMs, durationMs, hand, profile.width, keyCenterForPitch(hand, pitch, melody), pitch);
    notes.push(note);
    previousPitch[hand] = pitch;
    lastHandMs[hand] = hit.noteMs;

    const companion = makeCompanion(hit, note, frames, profile, key, melody, beatMs, density, previousPitch);
    if (companion) {
      notes.push(companion);
      previousPitch[companion.hand] = companion.pitch;
      lastHandMs[companion.hand] = companion.startMs;
    }
  }

  return notes;
}

function chooseHandForHit(hit: GridHit, profile: DifficultyProfile, lastHandMs: Record<Op3Hand, number>): Op3Hand {
  const lowDominant = hit.frame.low > Math.max(hit.frame.mid, hit.frame.high) * 1.12;
  const highDominant = hit.frame.high + hit.frame.mid * 0.35 > hit.frame.low * 1.08;
  const melodyLike = hit.melodyConfidence > 0.32 || highDominant || (hit.pitch !== null && hit.pitch >= 58);
  if (profile.difficulty === "normal") {
    if (melodyLike) return "right";
    if (lowDominant || hit.downbeat && hit.frame.brightness < 0.58) return "left";
    return hit.noteMs - lastHandMs.left > hit.noteMs - lastHandMs.right ? "left" : "right";
  }
  if (melodyLike && hit.melodyMotion > 0.08 && hit.noteMs - lastHandMs.right > 75) return "right";
  if (lowDominant && hit.noteMs - lastHandMs.left > 70) return "left";
  if (hit.downbeat && hit.pulse > 0.42 && hit.frame.brightness < 0.62) return "left";
  if (melodyLike && hit.noteMs - lastHandMs.right > 90) return "right";
  return hit.noteMs - lastHandMs.left > hit.noteMs - lastHandMs.right ? "left" : "right";
}

function pitchForHit(hit: GridHit, hand: Op3Hand, frames: AudioFrame[], key: KeyProfile, melody: MelodyMap): number {
  const lowDominant = hit.frame.low > Math.max(hit.frame.mid, hit.frame.high) * 1.12;
  if (hand === "left" && (lowDominant || hit.downbeat || hit.frame.brightness < 0.52)) {
    const pattern = hit.frame.energy > 0.58 ? [0, 7, 3, 7, 5, 7] : [0, 7, 5, 7];
    let pitch = key.root + pattern[Math.floor(hit.step / Math.max(1, Math.round(4 / 2))) % pattern.length] + 36;
    while (pitch > 54) pitch -= 12;
    while (pitch < 30) pitch += 12;
    return quantizeToKey(pitch, key);
  }

  if (hit.melodyNorm !== null && hit.melodyConfidence > 0.18) {
    const shaped = contourShape(hit.melodyNorm, hit.melodyExtreme);
    const range = hand === "left" ? [33, 56] : [49, 83];
    return quantizeToKey(Math.round(range[0] + shaped * (range[1] - range[0])), key);
  }

  if (hit.frame.energy > 0.12) {
    const shaped = contourShape(hit.spectralNorm, hit.frame.high > hit.frame.low * 1.35 ? 1 : hit.frame.low > hit.frame.high * 1.35 ? -1 : 0);
    const range = hand === "left" ? [32, 56] : [50, 82];
    return quantizeToKey(Math.round(range[0] + shaped * (range[1] - range[0])), key);
  }

  const detected = nearestReliablePitch(hit.frame, frames);
  if (detected !== null) {
    const normalized = clamp((detected - melody.low) / Math.max(8, melody.high - melody.low), 0.04, 0.96);
    const musical = 0.08 + normalized * 0.84;
    const range = hand === "left" ? [34, 55] : [50, 82];
    return quantizeToKey(Math.round(range[0] + musical * (range[1] - range[0])), key);
  }

  const fallback = hand === "left" ? [36, 40, 43, 47, 43, 40] : [60, 62, 64, 67, 69, 67, 64, 62];
  return quantizeToKey(fallback[hit.step % fallback.length] + key.root % 12, key);
}

function makeCompanion(hit: GridHit, primary: Op3Note, frames: AudioFrame[], profile: DifficultyProfile, key: KeyProfile, melody: MelodyMap, beatMs: number, density: number, previousPitch: Record<Op3Hand, number | null>): Op3Note | null {
  if (primary.type !== "tap") return null;
  if (!hit.downbeat && !(hit.onBeat && hit.score > 1.08)) return null;
  if (density < profile.chordDensity) return null;
  const hand: Op3Hand = primary.hand === "left" ? "right" : "left";
  const rawPitch = hand === "left" ? pitchForHit({ ...hit, frame: { ...hit.frame, brightness: 0.2 } }, hand, frames, key, melody) : pitchForHit(hit, hand, frames, key, melody) + 7;
  const pitch = smoothPitch(rawPitch, previousPitch[hand], hand, key);
  return makeNote(`${profile.difficulty}-${hit.step}-${hand}-pair`, hit.noteMs, beatMs * 0.2, hand, profile.width, keyCenterForPitch(hand, pitch, melody), pitch);
}

function holdLengthBeats(hit: GridHit, next: GridHit | undefined, frames: AudioFrame[], profile: DifficultyProfile, beatMs: number): number {
  if (hit.frame.onset > 0.28 || hit.pulse > 0.44 || hit.score < 0.92) return 0;
  if (profile.difficulty !== "normal" && hit.onBeat && hit.frame.energy < 0.62) return 0;
  const sustained = sustainedBeats(frames, hit.peakMs, beatMs);
  if (sustained < 1.65) return 0;
  const available = next ? (next.noteMs - hit.noteMs) / beatMs - 0.2 : sustained;
  const length = Math.min(sustained, available);
  if (length < 1.45) return 0;
  if (profile.difficulty === "normal") return clamp(length, 1.2, 2.5);
  if (profile.difficulty === "hard") return clamp(length, 1.15, 2);
  return clamp(length, 1.05, 1.6);
}

function findTrillRanges(hits: GridHit[], profile: DifficultyProfile, beatMs: number, density: number): Array<{ start: number; end: number }> {
  if (profile.difficulty === "normal" || density < 0.62) return [];
  const ranges: Array<{ start: number; end: number }> = [];
  const minRun = profile.difficulty === "hard" ? 5 : 4;

  for (let index = 0; index <= hits.length - minRun; index++) {
    const run = [index];
    while (run[run.length - 1] + 1 < hits.length) {
      const prev = hits[run[run.length - 1]];
      const nextIndex = run[run.length - 1] + 1;
      const next = hits[nextIndex];
      if (next.noteMs - prev.noteMs > beatMs * 0.42) break;
      if (prev.score < 0.76 || next.score < 0.76) break;
      const a = prev.pitch ?? prev.frame.melodyMidi;
      const b = next.pitch ?? next.frame.melodyMidi;
      if (a === null || b === null || Math.abs(a - b) < 2 || Math.abs(a - b) > 7) break;
      run.push(nextIndex);
    }
    if (run.length >= minRun) {
      ranges.push({ start: run[0], end: run[run.length - 1] });
      index = run[run.length - 1] + minRun;
    }
  }

  return ranges;
}

function makeTrill(run: GridHit[], profile: DifficultyProfile, key: KeyProfile, melody: MelodyMap): Op3Note {
  const avgBrightness = run.reduce((sum, hit) => sum + hit.frame.brightness, 0) / run.length;
  const hand: Op3Hand = avgBrightness > 0.54 ? "right" : "left";
  const pitches = run.map((hit) => hit.pitch ?? hit.frame.melodyMidi).filter((pitch): pitch is number => pitch !== null);
  const pitch = quantizeToKey(Math.round(average(pitches) || (hand === "left" ? 42 : 64)), key);
  const center = clamp(keyCenterForPitch(hand, pitch, melody), 0, 26);
  return {
    id: `${profile.difficulty}-trill-${run[0].step}-${hand}`,
    startMs: run[0].noteMs,
    endMs: Math.max(run[0].noteMs + 220, run[run.length - 1].noteMs),
    hand,
    minKey: center,
    maxKey: center + 1,
    pitch,
    type: "trill"
  };
}

function legalizeNotes(notes: Op3Note[], beatMs: number, difficulty: Op3Difficulty): Op3Note[] {
  const sorted = [...notes].sort((a, b) => a.startMs - b.startMs || compositeRank(b) - compositeRank(a) || a.minKey - b.minKey);
  const kept: Op3Note[] = [];
  const composites: Op3Note[] = [];
  const lastByHand: Partial<Record<Op3Hand, Op3Note>> = {};
  const minTapGap = difficulty === "normal" ? beatMs * 0.36 : difficulty === "hard" ? beatMs * 0.18 : beatMs * 0.11;
  const compositeGap = Math.max(85, beatMs * 0.16);

  for (const note of sorted) {
    const fixed = note.type === "trill" ? normalizeTrill(note) : note;
    const composite = fixed.type === "hold" || fixed.type === "trill";
    if (composites.some((other) => reservedOverlap(fixed, other, compositeGap))) continue;
    if (!composite && composites.some((other) => notesOverlap(fixed, other) || reservedOverlap(fixed, other, 10))) continue;
    const last = lastByHand[fixed.hand];
    if (!composite && last && fixed.startMs - last.startMs < minTapGap) continue;
    if (!composite && kept.filter((other) => Math.abs(other.startMs - fixed.startMs) <= 24).length >= (difficulty === "normal" ? 2 : 3)) continue;
    kept.push(fixed);
    lastByHand[fixed.hand] = fixed;
    if (composite) composites.push(fixed);
  }

  return kept.sort((a, b) => a.startMs - b.startMs || a.minKey - b.minKey);
}

function analyzeBuffer(buffer: AudioBuffer): AudioFrame[] {
  const sampleRate = buffer.sampleRate;
  const frameSize = 2048;
  const hopSize = 1024;
  const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, index) => buffer.getChannelData(index));
  const energy: number[] = [];
  const brightness: number[] = [];
  const low: number[] = [];
  const mid: number[] = [];
  const high: number[] = [];
  const pitch: Array<{ pitchMidi: number | null; pitchConfidence: number }> = [];

  for (let start = 0; start + frameSize < buffer.length; start += hopSize) {
    const stats = frameStats(channels, start, frameSize, 1);
    const bands = spectralBands(channels, start, sampleRate);
    energy.push(stats.rms);
    brightness.push(stats.brightness);
    low.push(bands.low);
    mid.push(bands.mid);
    high.push(bands.high);
    pitch.push(start % (hopSize * 2) === 0 ? estimatePitch(channels, start, sampleRate, stats.rms) : { pitchMidi: null, pitchConfidence: 0 });
  }

  return buildFrames(energy, brightness, pitch, hopSize, sampleRate, { low, mid, high });
}

function analyzeRhythmBuffer(buffer: AudioBuffer): AudioFrame[] {
  const sampleRate = buffer.sampleRate;
  const frameSize = 2048;
  const hopSize = 1024;
  const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, index) => buffer.getChannelData(index));
  const energy: number[] = [];
  const brightness: number[] = [];

  for (let start = 0; start + frameSize < buffer.length; start += hopSize) {
    const stats = frameStats(channels, start, frameSize, 2);
    energy.push(stats.rms);
    brightness.push(stats.brightness);
  }

  return buildFrames(energy, brightness, energy.map(() => ({ pitchMidi: null, pitchConfidence: 0 })), hopSize, sampleRate);
}

function buildFrames(
  energyRaw: number[],
  brightnessRaw: number[],
  pitch: Array<{ pitchMidi: number | null; pitchConfidence: number }>,
  hopSize: number,
  sampleRate: number,
  bandsRaw?: { low: number[]; mid: number[]; high: number[] }
): AudioFrame[] {
  const energy = normalize(energyRaw);
  const brightness = normalize(brightnessRaw);
  const low = normalize(bandsRaw?.low ?? energyRaw);
  const mid = normalize(bandsRaw?.mid ?? brightnessRaw);
  const high = normalize(bandsRaw?.high ?? brightnessRaw);
  const flux = energy.map((value, index) => {
    const rise = Math.max(0, value - (energy[index - 1] ?? value));
    const brightRise = Math.max(0, brightness[index] - (brightness[index - 1] ?? brightness[index]));
    const highRise = Math.max(0, high[index] - (high[index - 1] ?? high[index]));
    const lowRise = Math.max(0, low[index] - (low[index - 1] ?? low[index]));
    return rise * 0.58 + brightRise * 0.14 + highRise * 0.16 + lowRise * 0.08 + maxAround(energy, index, 1) * 0.04;
  });
  const onset = normalize(flux.map((value, index) => maxAround(flux, index, 2) * 0.7 + value * 0.3));
  return energy.map((value, index) => ({
    timeMs: index * hopSize / sampleRate * 1000,
    energy: value,
    onset: onset[index],
    brightness: brightness[index],
    low: low[index],
    mid: mid[index],
    high: high[index],
    spectralNorm: spectralNorm(low[index], mid[index], high[index]),
    pitchMidi: pitch[index].pitchMidi,
    pitchConfidence: pitch[index].pitchConfidence,
    melodyMidi: smoothMelodyPitch(pitch, index)
  }));
}

function estimateBpm(frames: AudioFrame[]): BpmEstimate | null {
  if (frames.length < 60) return null;
  const frameMs = Math.max(1, frames[1].timeMs - frames[0].timeMs);
  const scores = frames.map((frame) => frame.onset * 0.84 + frame.energy * 0.16);
  const candidates: Array<{ bpm: number; score: number; phaseMs: number }> = [];
  for (let bpm = 60; bpm <= 220; bpm += 0.5) {
    candidates.push({ bpm, ...beatScore(scores, frameMs, 60000 / bpm) });
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score <= 0) return null;
  const runner = candidates.find((candidate) => Math.abs(candidate.bpm - best.bpm) > 4);
  const beatMs = 60000 / best.bpm;
  return {
    bpm: Math.round(best.bpm * 10) / 10,
    offsetMs: Math.round(positiveModulo(best.phaseMs, beatMs)),
    confidence: clamp(runner ? (best.score - runner.score) / best.score : 1, 0, 1),
    alternatives: buildBpmAlternatives(best, candidates)
  };
}

function beatScore(scores: number[], frameMs: number, beatMs: number): { score: number; phaseMs: number } {
  let best = { score: 0, phaseMs: 0 };
  for (let phase = 0; phase < 32; phase++) {
    const phaseMs = beatMs * phase / 32;
    let score = 0;
    let count = 0;
    for (let timeMs = phaseMs; timeMs < scores.length * frameMs; timeMs += beatMs / 2) {
      const index = Math.round(timeMs / frameMs);
      const weight = positiveModulo(timeMs - phaseMs, beatMs) < 1 ? 1 : 0.58;
      score += localScore(scores, index, Math.max(1, Math.round(beatMs * 0.1 / frameMs))) * weight;
      count++;
    }
    const normalized = count > 0 ? score / count : 0;
    if (normalized > best.score) best = { score: normalized, phaseMs };
  }
  return best;
}

function buildBpmAlternatives(best: { bpm: number; score: number; phaseMs: number }, candidates: Array<{ bpm: number; score: number; phaseMs: number }>): Array<{ bpm: number; offsetMs: number; confidence: number }> {
  const choices = new Map<number, { bpm: number; score: number; phaseMs: number }>();
  for (const candidate of candidates.slice(0, 24)) choices.set(Math.round(candidate.bpm * 10), candidate);
  for (const factor of [0.5, 2]) {
    const bpm = best.bpm * factor;
    if (bpm >= 45 && bpm <= 280) choices.set(Math.round(bpm * 10), { bpm, score: best.score * 0.96, phaseMs: positiveModulo(best.phaseMs, 60000 / bpm) });
  }
  return [...choices.values()]
    .sort((a, b) => b.score - a.score)
    .filter((candidate, index, all) => all.findIndex((other) => Math.abs(other.bpm - candidate.bpm) < 2) === index)
    .slice(0, 5)
    .map((candidate) => ({
      bpm: Math.round(candidate.bpm * 10) / 10,
      offsetMs: Math.round(positiveModulo(candidate.phaseMs, 60000 / candidate.bpm)),
      confidence: clamp(candidate.score / Math.max(0.001, best.score), 0, 1)
    }));
}

function frameStats(channels: Float32Array[], start: number, frameSize: number, stride: number): { rms: number; brightness: number } {
  let sum = 0;
  let diff = 0;
  let previous = 0;
  let count = 0;
  for (let i = 0; i < frameSize; i += stride) {
    const sample = mono(channels, start + i);
    sum += sample * sample;
    diff += Math.abs(sample - previous);
    previous = sample;
    count++;
  }
  return { rms: Math.sqrt(sum / Math.max(1, count)), brightness: diff / Math.max(1, count) };
}

function spectralBands(channels: Float32Array[], start: number, sampleRate: number): { low: number; mid: number; high: number } {
  const low = (
    goertzelPower(channels, start, sampleRate, 98) +
    goertzelPower(channels, start, sampleRate, 147) +
    goertzelPower(channels, start, sampleRate, 220)
  ) / 3;
  const mid = (
    goertzelPower(channels, start, sampleRate, 330) +
    goertzelPower(channels, start, sampleRate, 494) +
    goertzelPower(channels, start, sampleRate, 740)
  ) / 3;
  const high = (
    goertzelPower(channels, start, sampleRate, 988) +
    goertzelPower(channels, start, sampleRate, 1480) +
    goertzelPower(channels, start, sampleRate, 2217) +
    goertzelPower(channels, start, sampleRate, 3136)
  ) / 4;
  return { low, mid, high };
}

function goertzelPower(channels: Float32Array[], start: number, sampleRate: number, frequency: number): number {
  const samples = 1024;
  const omega = 2 * Math.PI * frequency / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples; i += 2) {
    const sample = mono(channels, start + i);
    s0 = sample + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2);
}

function estimatePitch(channels: Float32Array[], start: number, sampleRate: number, rms: number): { pitchMidi: number | null; pitchConfidence: number } {
  if (rms < 0.01) return { pitchMidi: null, pitchConfidence: 0 };
  const minLag = Math.floor(sampleRate / 900);
  const maxLag = Math.floor(sampleRate / 75);
  let bestLag = 0;
  let best = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    let power = 0;
    for (let i = 0; i < 1024; i++) {
      const a = mono(channels, start + i);
      const b = mono(channels, start + i + lag);
      corr += a * b;
      power += a * a + b * b;
    }
    const score = power > 0 ? corr / power : 0;
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  const confidence = clamp(best * 2, 0, 1);
  if (confidence < 0.28 || bestLag <= 0) return { pitchMidi: null, pitchConfidence: confidence };
  const midi = Math.round(69 + 12 * Math.log2(sampleRate / bestLag / 440));
  if (!Number.isFinite(midi) || midi < 24 || midi > 96) return { pitchMidi: null, pitchConfidence: confidence };
  return { pitchMidi: midi, pitchConfidence: confidence };
}

function compressAudioGuide(frames: AudioFrame[], maxPoints: number): AudioGuidePoint[] {
  if (frames.length <= maxPoints) return frames.map(({ timeMs, energy, onset, brightness }) => ({ timeMs, energy, onset, brightness }));
  const bucketSize = Math.ceil(frames.length / maxPoints);
  const points: AudioGuidePoint[] = [];
  for (let index = 0; index < frames.length; index += bucketSize) {
    const bucket = frames.slice(index, index + bucketSize);
    points.push({
      timeMs: bucket[Math.floor(bucket.length / 2)].timeMs,
      energy: Math.max(...bucket.map((frame) => frame.energy)),
      onset: Math.max(...bucket.map((frame) => frame.onset)),
      brightness: Math.max(...bucket.map((frame) => frame.brightness))
    });
  }
  return points;
}

function renderNotePitches(notes: Op3Note[], frames: AudioFrame[], key: KeyProfile): Op3Note[] {
  const melody = buildMelodyMap(frames);
  const previous: Record<Op3Hand, number | null> = { left: null, right: null, both: null };
  return [...notes].sort((a, b) => a.startMs - b.startMs || a.minKey - b.minKey).map((note) => {
    const frame = frameAt(frames, note.startMs);
    const raw = Number.isFinite(note.pitch) ? note.pitch : pitchForFrame(note.hand, frame, frames, key, melody);
    const pitch = smoothPitch(raw, previous[note.hand], note.hand, key);
    previous[note.hand] = pitch;
    const width = note.maxKey - note.minKey + 1;
    const center = keyCenterForPitch(note.hand, pitch, melody);
    const minKey = clamp(center - Math.floor((width - 1) / 2), 0, 27);
    return { ...note, pitch, minKey, maxKey: clamp(minKey + width - 1, 0, 27) };
  });
}

function pitchForFrame(hand: Op3Hand, frame: AudioFrame, frames: AudioFrame[], key: KeyProfile, melody: MelodyMap): number {
  const detected = nearestReliablePitch(frame, frames);
  if (detected === null) return hand === "left" ? key.root + 36 : key.root + 60;
  const range = hand === "left" ? [34, 56] : hand === "right" ? [52, 82] : [42, 74];
  const normalized = clamp((detected - melody.low) / Math.max(8, melody.high - melody.low), 0, 1);
  return quantizeToKey(Math.round(range[0] + normalized * (range[1] - range[0])), key);
}

function smoothPitch(raw: number, previous: number | null, hand: Op3Hand, key: KeyProfile): number {
  const min = hand === "left" ? 28 : hand === "right" ? 48 : 38;
  const max = hand === "left" ? 58 : hand === "right" ? 84 : 76;
  const fitted = fitPitch(raw, min, max, key);
  if (previous === null) return fitted;
  const choices = [-12, 0, 12].map((offset) => fitPitch(fitted + offset, min, max, key));
  return choices.sort((a, b) => {
    const aj = Math.abs(a - previous);
    const bj = Math.abs(b - previous);
    const ap = aj < 2 ? 2 : aj > 12 ? 5 : 0;
    const bp = bj < 2 ? 2 : bj > 12 ? 5 : 0;
    return aj + ap - (bj + bp);
  })[0];
}

function fitPitch(pitch: number, min: number, max: number, key: KeyProfile): number {
  let value = quantizeToKey(Math.round(pitch), key);
  while (value < min) value += 12;
  while (value > max) value -= 12;
  return clamp(value, min, max);
}

function sustainedBeats(frames: AudioFrame[], timeMs: number, beatMs: number): number {
  for (const beats of [3, 2.5, 2, 1.5, 1.25]) {
    if (sustainScore(frames, timeMs, beatMs * beats) > 0.56) return beats;
  }
  return 0;
}

function sustainScore(frames: AudioFrame[], timeMs: number, durationMs: number): number {
  const window = frames.filter((frame) => frame.timeMs >= timeMs && frame.timeMs <= timeMs + durationMs);
  if (window.length < 4) return 0;
  const energy = average(window.map((frame) => frame.energy));
  const calm = 1 - average(window.map((frame) => frame.onset));
  const voiced = window.filter((frame) => frame.melodyMidi !== null || frame.pitchConfidence > 0.24).length / window.length;
  return clamp(energy * 0.38 + calm * 0.28 + voiced * 0.34, 0, 1);
}

function targetNoteCount(durationMs: number, profile: DifficultyProfile, density: number, sensitivity: number): number {
  const minutes = Math.max(0.5, durationMs / 60000);
  const perMinute = profile.notesPerMinute[0] + (profile.notesPerMinute[1] - profile.notesPerMinute[0]) * clamp(density * 0.72 + sensitivity * 0.28, 0, 1.15);
  return Math.round(minutes * perMinute);
}

function makeNote(id: string, startMs: number, durationMs: number, hand: Op3Hand, width: number, center: number, pitch: number): Op3Note {
  const minKey = clamp(Math.round(center - Math.floor((width - 1) / 2)), 0, 27);
  const maxKey = clamp(minKey + width - 1, 0, 27);
  return {
    id,
    startMs: Math.round(startMs),
    endMs: Math.round(startMs + durationMs),
    hand,
    minKey,
    maxKey,
    pitch,
    type: durationMs > 520 ? "hold" : "tap"
  };
}

function keyCenterForPitch(hand: Op3Hand, pitch: number, melody: MelodyMap): number {
  void melody;
  if (hand === "left") {
    const normalized = clamp((pitch - 32) / 25, 0, 1);
    return clamp(Math.round(4 + normalized * 9), 4, 13);
  }
  if (hand === "both") {
    const normalized = clamp((pitch - 42) / 34, 0, 1);
    return clamp(Math.round(8 + normalized * 11), 8, 19);
  }
  const normalized = clamp((pitch - 50) / 34, 0, 1);
  return clamp(Math.round(14 + normalized * 11), 14, 25);
}

function buildMelodyMap(frames: AudioFrame[]): MelodyMap {
  const raw = frames.map((frame) => {
    const midi = frame.melodyMidi ?? (frame.pitchConfidence > 0.34 ? frame.pitchMidi : null);
    const confidence = midi === null ? 0 : Math.max(frame.pitchConfidence, frame.melodyMidi !== null ? 0.42 : 0);
    return { midi, confidence };
  });
  const smoothed = smoothContour(raw, frames);
  const pitches = smoothed
    .filter((frame) => frame.energy > 0.1)
    .map((frame) => frame.midi)
    .filter((pitch): pitch is number => pitch !== null)
    .sort((a, b) => a - b);
  const low = pitches.length < 8 ? 48 : pitches[Math.floor(pitches.length * 0.08)];
  const high = pitches.length < 8 ? 84 : pitches[Math.floor(pitches.length * 0.92)];
  const points: MelodyPoint[] = smoothed.map((entry, index) => {
    const current = entry.midi;
    const norm = current === null ? null : clamp((current - low) / Math.max(8, high - low), 0, 1);
    const previous = smoothed[Math.max(0, index - 6)].midi;
    const next = smoothed[Math.min(smoothed.length - 1, index + 6)].midi;
    const motion = current === null || previous === null ? 0 : clamp(Math.abs(current - previous) / 12, 0, 1);
    const extreme: MelodyPoint["extreme"] = current === null || norm === null || previous === null || next === null
      ? 0
      : current - previous > 1.5 && current - next > 1.5
        ? 1
        : previous - current > 1.5 && next - current > 1.5
          ? -1
          : 0;
    return {
      timeMs: frames[index].timeMs,
      midi: current,
      norm,
      confidence: entry.confidence,
      motion,
      extreme
    };
  });
  return { low, high, points };
}

function smoothContour(raw: Array<{ midi: number | null; confidence: number }>, frames: AudioFrame[]): Array<{ midi: number | null; confidence: number; energy: number }> {
  const filled = raw.map((entry, index) => {
    if (entry.midi !== null) return { ...entry, energy: frames[index].energy };
    const prev = nearestVoiced(raw, index, -1, 22);
    const next = nearestVoiced(raw, index, 1, 22);
    if (!prev && !next) return { midi: null, confidence: 0, energy: frames[index].energy };
    if (prev && next) {
      const span = next.index - prev.index;
      const mix = span <= 0 ? 0 : (index - prev.index) / span;
      return {
        midi: prev.midi + (next.midi - prev.midi) * mix,
        confidence: Math.min(prev.confidence, next.confidence) * 0.72,
        energy: frames[index].energy
      };
    }
    const only = prev ?? next;
    if (!only) return { midi: null, confidence: 0, energy: frames[index].energy };
    const distance = Math.abs(index - only.index);
    return {
      midi: only.midi,
      confidence: only.confidence * clamp(1 - distance / 24, 0, 0.68),
      energy: frames[index].energy
    };
  });

  return filled.map((entry, index) => {
    if (entry.midi === null) return entry;
    const window = filled
      .slice(Math.max(0, index - 7), Math.min(filled.length, index + 8))
      .filter((candidate): candidate is { midi: number; confidence: number; energy: number } => candidate.midi !== null && candidate.confidence > 0.12)
      .sort((a, b) => a.midi - b.midi);
    if (window.length < 3) return entry;
    const median = window[Math.floor(window.length / 2)].midi;
    const averagePitch = average(window.map((candidate) => candidate.midi * candidate.confidence)) / Math.max(0.001, average(window.map((candidate) => candidate.confidence)));
    return {
      midi: median * 0.68 + averagePitch * 0.32,
      confidence: clamp(entry.confidence + 0.18, 0, 1),
      energy: entry.energy
    };
  });
}

function nearestVoiced(raw: Array<{ midi: number | null; confidence: number }>, start: number, direction: -1 | 1, maxSteps: number): { index: number; midi: number; confidence: number } | null {
  for (let offset = 1; offset <= maxSteps; offset++) {
    const index = start + offset * direction;
    if (index < 0 || index >= raw.length) break;
    const entry = raw[index];
    if (entry.midi !== null && entry.confidence > 0.22) return { index, midi: entry.midi, confidence: entry.confidence };
  }
  return null;
}

function melodyPointAt(melody: MelodyMap, timeMs: number): MelodyPoint {
  if (melody.points.length === 0) return { timeMs, midi: null, norm: null, confidence: 0, motion: 0, extreme: 0 };
  const frameMs = Math.max(1, melody.points[1]?.timeMs - melody.points[0]?.timeMs || 23);
  return melody.points[clamp(Math.round(timeMs / frameMs), 0, melody.points.length - 1)];
}

function contourShape(norm: number, extreme: -1 | 0 | 1): number {
  const expanded = 0.08 + norm * 0.84;
  if (extreme > 0) return clamp(expanded + 0.1, 0, 1);
  if (extreme < 0) return clamp(expanded - 0.1, 0, 1);
  return expanded;
}

function nearestReliablePitch(frame: AudioFrame, frames: AudioFrame[]): number | null {
  if (frame.melodyMidi !== null) return frame.melodyMidi;
  if (frame.pitchMidi !== null && frame.pitchConfidence >= 0.34) return frame.pitchMidi;
  const nearby = frames
    .filter((candidate) => candidate.pitchMidi !== null && candidate.pitchConfidence >= 0.34 && Math.abs(candidate.timeMs - frame.timeMs) <= 180)
    .sort((a, b) => Math.abs(a.timeMs - frame.timeMs) - Math.abs(b.timeMs - frame.timeMs));
  return nearby[0]?.pitchMidi ?? null;
}

function smoothMelodyPitch(readings: Array<{ pitchMidi: number | null; pitchConfidence: number }>, index: number): number | null {
  const nearby: number[] = [];
  for (let i = Math.max(0, index - 8); i <= Math.min(readings.length - 1, index + 8); i++) {
    const reading = readings[i];
    if (reading.pitchMidi !== null && reading.pitchConfidence >= 0.3) nearby.push(reading.pitchMidi);
  }
  if (nearby.length < 2) return null;
  nearby.sort((a, b) => a - b);
  return nearby[Math.floor(nearby.length / 2)];
}

function detectKey(frames: AudioFrame[]): KeyProfile {
  const scales = [
    { mode: "major" as const, allowed: [0, 2, 4, 5, 7, 9, 11] },
    { mode: "minor" as const, allowed: [0, 2, 3, 5, 7, 8, 10] }
  ];
  let best: KeyProfile & { score: number } = { root: 0, mode: "minor", allowed: scales[1].allowed, score: -Infinity };
  for (let root = 0; root < 12; root++) {
    for (const scale of scales) {
      let score = 0;
      for (const frame of frames) {
        const pitch = frame.melodyMidi ?? frame.pitchMidi;
        if (pitch === null) continue;
        const pc = positiveModulo(pitch, 12);
        const inKey = scale.allowed.some((allowed) => (allowed + root) % 12 === pc);
        score += (inKey ? 1 : -0.35) * Math.max(0.2, frame.pitchConfidence) * Math.max(0.2, frame.energy);
      }
      if (score > best.score) best = { root, mode: scale.mode, allowed: scale.allowed, score };
    }
  }
  return { root: best.root, mode: best.mode, allowed: best.allowed };
}

function quantizeToKey(midi: number, key: KeyProfile): number {
  const pc = positiveModulo(midi, 12);
  const allowed = key.allowed.map((value) => (value + key.root) % 12);
  let best = allowed[0];
  for (const candidate of allowed) {
    const dist = Math.min(Math.abs(candidate - pc), 12 - Math.abs(candidate - pc));
    const bestDist = Math.min(Math.abs(best - pc), 12 - Math.abs(best - pc));
    if (dist < bestDist) best = candidate;
  }
  let delta = best - pc;
  if (delta > 6) delta -= 12;
  if (delta < -6) delta += 12;
  return midi + delta;
}

function peakFrameAround(frames: AudioFrame[], timeMs: number, radiusMs: number): AudioFrame {
  let best = frameAt(frames, timeMs);
  let bestScore = -Infinity;
  for (const frame of frames) {
    if (Math.abs(frame.timeMs - timeMs) > radiusMs) continue;
    const score = frame.onset * 0.76 + frame.energy * 0.2 + frame.brightness * 0.04;
    if (score > bestScore) {
      best = frame;
      bestScore = score;
    }
  }
  return best;
}

function frameAt(frames: AudioFrame[], timeMs: number): AudioFrame {
  if (frames.length === 0) return { timeMs, energy: 0, onset: 0, brightness: 0, low: 0, mid: 0, high: 0, spectralNorm: 0.5, pitchMidi: null, pitchConfidence: 0, melodyMidi: null };
  const index = clamp(Math.round(timeMs / Math.max(1, frames[1]?.timeMs - frames[0]?.timeMs || 23)), 0, frames.length - 1);
  return frames[index];
}

function localPulse(frames: AudioFrame[], timeMs: number, radiusMs: number): number {
  const peak = peakFrameAround(frames, timeMs, radiusMs);
  const centered = 1 - clamp(Math.abs(peak.timeMs - timeMs) / Math.max(1, radiusMs), 0, 1) * 0.25;
  return clamp((peak.onset * 0.82 + peak.energy * 0.18) * centered, 0, 1);
}

function localScore(scores: number[], index: number, radius: number): number {
  let best = 0;
  for (let i = Math.max(0, index - radius); i <= Math.min(scores.length - 1, index + radius); i++) {
    const centered = 1 - Math.abs(i - index) / Math.max(1, radius) * 0.25;
    best = Math.max(best, (scores[i] ?? 0) * centered);
  }
  return best;
}

function melodyMotion(frames: AudioFrame[], timeMs: number): number {
  const current = frameAt(frames, timeMs).melodyMidi;
  const previous = frameAt(frames, timeMs - 180).melodyMidi;
  if (current === null || previous === null) return 0;
  return clamp(Math.abs(current - previous) / 12, 0, 1);
}

function reservedOverlap(a: Op3Note, b: Op3Note, gapMs: number): boolean {
  const timeOverlap = a.startMs < b.endMs + gapMs && a.endMs > b.startMs - gapMs;
  const sameHand = a.hand === "both" || b.hand === "both" || a.hand === b.hand;
  const nearbyKeys = a.minKey <= b.maxKey + 1 && a.maxKey >= b.minKey - 1;
  return timeOverlap && (sameHand || nearbyKeys);
}

function normalizeTrill(note: Op3Note): Op3Note {
  const center = clamp(Math.round((note.minKey + note.maxKey) / 2), 0, 26);
  return { ...note, minKey: center, maxKey: center + 1 };
}

function compositeRank(note: Op3Note): number {
  if (note.type === "hold") return 2;
  if (note.type === "trill") return 1;
  return 0;
}

function mono(channels: Float32Array[], index: number): number {
  let value = 0;
  for (const channel of channels) value += channel[index] ?? 0;
  return value / Math.max(1, channels.length);
}

function spectralNorm(low: number, mid: number, high: number): number {
  const total = low + mid + high + 0.000001;
  return clamp((mid * 0.48 + high * 1.08) / total, 0, 1);
}

function normalize(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const low = sorted[Math.floor(sorted.length * 0.08)] ?? 0;
  const high = sorted[Math.floor(sorted.length * 0.985)] ?? 1;
  const span = Math.max(0.000001, high - low);
  return values.map((value) => clamp((value - low) / span, 0, 1));
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[clamp(Math.round((sorted.length - 1) * ratio), 0, sorted.length - 1)] ?? 0;
}

function maxAround(values: number[], center: number, radius: number): number {
  let best = 0;
  for (let i = Math.max(0, center - radius); i <= Math.min(values.length - 1, center + radius); i++) best = Math.max(best, values[i]);
  return best;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
