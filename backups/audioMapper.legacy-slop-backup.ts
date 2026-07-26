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
  subdivisions: number;
  threshold: number;
  width: number;
  holdEvery: number;
  maxNotes: number;
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
  span: number;
};

type MusicEvent = {
  timeMs: number;
  gridMs: number;
  step: number;
  frame: AudioFrame;
  score: number;
  accent: number;
  pitch: number | null;
  handHint: Op3Hand;
  onBeat: boolean;
  downbeat: boolean;
};

type RhythmCandidate = {
  step: number;
  gridMs: number;
  peakMs: number;
  frame: AudioFrame;
  score: number;
  pulse: number;
  beatWeight: number;
  bar: number;
  slot: number;
  onBeat: boolean;
  downbeat: boolean;
  pitch: number | null;
};

const profiles: DifficultyProfile[] = [
  { difficulty: "normal", level: 4, subdivisions: 2, threshold: 0.5, width: 5, holdEvery: 32, maxNotes: 720 },
  { difficulty: "hard", level: 7, subdivisions: 3, threshold: 0.46, width: 4, holdEvery: 24, maxNotes: 1200 },
  { difficulty: "expert", level: 10, subdivisions: 4, threshold: 0.38, width: 3, holdEvery: 18, maxNotes: 1900 },
  { difficulty: "real", level: 13, subdivisions: 6, threshold: 0.32, width: 3, holdEvery: 16, maxNotes: 2600 }
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
      const generatedNotes = generateChart(frames, next, profile, key, options);
      next.charts[profile.difficulty] = {
        difficulty: profile.difficulty,
        level: profile.level,
        notes: removeTapHoldOverlaps(renderNotePitches(generatedNotes, frames, key))
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
    const frames = analyzeRhythmBuffer(buffer);
    return estimateBpm(frames);
  } finally {
    await context.close();
  }
}

export async function analyzeAudioGuideFromAudio(file: File): Promise<AudioGuidePoint[]> {
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    return compressAudioGuide(analyzeRhythmBuffer(buffer), 2400);
  } finally {
    await context.close();
  }
}

export async function renderProjectPitchesFromAudio(file: File, project: Op3SongProject): Promise<Op3SongProject> {
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    const frames = analyzeBuffer(buffer);
    return renderProjectPitches(project, frames, Math.round(buffer.duration * 1000), detectKey(frames));
  } finally {
    await context.close();
  }
}

function estimateBpm(frames: AudioFrame[]): BpmEstimate | null {
  if (frames.length < 60) return null;

  const frameMs = Math.max(1, frames[1]?.timeMs - frames[0]?.timeMs || 23);
  const onsetScores = frames.map((frame) => frame.onset * 0.82 + frame.energy * 0.18);
  const peakScores = onsetScores.map((value, index) => {
    let peak = value;
    for (let i = Math.max(0, index - 3); i <= Math.min(onsetScores.length - 1, index + 3); i++) {
      peak = Math.max(peak, onsetScores[i]);
    }
    return peak;
  });

  const coarseCandidates: Array<{ bpm: number; score: number; phaseMs: number }> = [];
  for (let bpm = 65; bpm <= 220; bpm += 1) {
    const beatMs = 60000 / bpm;
    coarseCandidates.push({ bpm, ...beatGridScore(peakScores, frameMs, beatMs) });
  }

  coarseCandidates.sort((a, b) => b.score - a.score);
  const seeds = coarseCandidates.slice(0, 5).map((candidate) => candidate.bpm);
  const candidates: Array<{ bpm: number; score: number; phaseMs: number }> = [];
  for (const seed of seeds) {
    for (let bpm = seed - 1.5; bpm <= seed + 1.5; bpm += 0.1) {
      if (bpm < 60 || bpm > 240) continue;
      const rounded = Math.round(bpm * 10) / 10;
      if (candidates.some((candidate) => candidate.bpm === rounded)) continue;
      candidates.push({ bpm: rounded, ...beatGridScore(peakScores, frameMs, 60000 / rounded) });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0] ?? coarseCandidates[0];
  if (!best || best.score <= 0) return null;

  const runnerUp = candidates.find((candidate) => Math.abs(candidate.bpm - best.bpm) > 4);
  const confidence = clamp(runnerUp ? (best.score - runnerUp.score) / Math.max(best.score, 0.001) : 1, 0, 1);
  const beatMs = 60000 / best.bpm;
  const alternatives = buildBpmAlternatives(best, candidates);
  return {
    bpm: Math.round(best.bpm * 10) / 10,
    confidence,
    offsetMs: Math.round(positiveModulo(best.phaseMs, beatMs)),
    alternatives
  };
}

function buildBpmAlternatives(best: { bpm: number; score: number; phaseMs: number }, candidates: Array<{ bpm: number; score: number; phaseMs: number }>): Array<{ bpm: number; offsetMs: number; confidence: number }> {
  const choices = new Map<number, { bpm: number; score: number; phaseMs: number }>();
  const addChoice = (candidate: { bpm: number; score: number; phaseMs: number }) => {
    const rounded = Math.round(candidate.bpm * 10) / 10;
    const existing = choices.get(rounded);
    if (!existing || candidate.score > existing.score) choices.set(rounded, { ...candidate, bpm: rounded });
  };

  for (const candidate of candidates.slice(0, 24)) addChoice(candidate);
  for (const factor of [0.5, 2]) {
    const bpm = best.bpm * factor;
    if (bpm >= 45 && bpm <= 280) {
      addChoice({
        bpm,
        score: best.score * 0.96,
        phaseMs: positiveModulo(best.phaseMs, 60000 / bpm)
      });
    }
  }

  return [...choices.values()]
    .sort((a, b) => b.score - a.score)
    .filter((candidate, index, all) => all.findIndex((other) => Math.abs(other.bpm - candidate.bpm) < 2) === index)
    .slice(0, 5)
    .map((candidate) => ({
      bpm: Math.round(candidate.bpm * 10) / 10,
      offsetMs: Math.round(positiveModulo(candidate.phaseMs, 60000 / candidate.bpm)),
      confidence: clamp(candidate.score / Math.max(best.score, 0.001), 0, 1)
    }));
}

function beatGridScore(scores: number[], frameMs: number, beatMs: number): { score: number; phaseMs: number } {
  const durationMs = scores.length * frameMs;
  if (durationMs < beatMs * 8) return { score: 0, phaseMs: 0 };

  let bestPhaseScore = 0;
  let bestPhaseMs = 0;
  const phaseSteps = 32;
  for (let phase = 0; phase < phaseSteps; phase++) {
    const phaseMs = beatMs * phase / phaseSteps;
    let score = 0;
    let count = 0;

    for (let timeMs = phaseMs; timeMs < durationMs; timeMs += beatMs / 2) {
      const beatWeight = Math.abs(positiveModulo(timeMs - phaseMs, beatMs)) < 1 ? 1 : 0.58;
      score += gridPulseScore(scores, frameMs, timeMs, beatMs) * beatWeight;
      count++;
    }

    const normalized = count > 0 ? score / count : 0;
    if (normalized > bestPhaseScore) {
      bestPhaseScore = normalized;
      bestPhaseMs = phaseMs;
    }
  }

  return refineBeatPhase(scores, frameMs, beatMs, bestPhaseMs, bestPhaseScore);
}

function refineBeatPhase(scores: number[], frameMs: number, beatMs: number, phaseMs: number, fallbackScore: number): { score: number; phaseMs: number } {
  let best = { score: fallbackScore, phaseMs };
  const searchRadius = beatMs / 32;
  const phaseStepMs = Math.max(2, frameMs / 3);
  for (let candidate = phaseMs - searchRadius; candidate <= phaseMs + searchRadius; candidate += phaseStepMs) {
    const wrapped = positiveModulo(candidate, beatMs);
    let score = 0;
    let count = 0;
    for (let timeMs = wrapped; timeMs < scores.length * frameMs; timeMs += beatMs / 2) {
      const halfBeat = positiveModulo(timeMs - wrapped, beatMs) > beatMs * 0.25;
      score += gridPulseScore(scores, frameMs, timeMs, beatMs) * (halfBeat ? 0.58 : 1);
      count++;
    }
    const normalized = count > 0 ? score / count : 0;
    if (normalized > best.score) best = { score: normalized, phaseMs: wrapped };
  }
  return best;
}

function gridPulseScore(scores: number[], frameMs: number, timeMs: number, beatMs: number): number {
  const centerIndex = clamp(Math.round(timeMs / frameMs), 0, scores.length - 1);
  const radiusFrames = Math.max(1, Math.round(Math.min(beatMs * 0.12, 72) / frameMs));
  let bestScore = 0;
  let bestDistance = 0;

  for (let index = Math.max(0, centerIndex - radiusFrames); index <= Math.min(scores.length - 1, centerIndex + radiusFrames); index++) {
    const distance = Math.abs(index - centerIndex) / Math.max(1, radiusFrames);
    const score = localScoreAt(scores, index);
    if (score > bestScore) {
      bestScore = score;
      bestDistance = distance;
    }
  }

  return bestScore * (1 - bestDistance * 0.34);
}

function localScoreAt(scores: number[], index: number): number {
  const safeIndex = clamp(index, 0, scores.length - 1);
  return (
    (scores[safeIndex] ?? 0) * 0.64 +
    Math.max(scores[safeIndex - 1] ?? 0, scores[safeIndex + 1] ?? 0) * 0.28 +
    Math.max(scores[safeIndex - 2] ?? 0, scores[safeIndex + 2] ?? 0) * 0.08
  );
}

function analyzeRhythmBuffer(buffer: AudioBuffer): AudioFrame[] {
  const sampleRate = buffer.sampleRate;
  const frameSize = 2048;
  const hopSize = 1024;
  const channelCount = Math.min(buffer.numberOfChannels, 2);
  const channels = Array.from({ length: channelCount }, (_, channel) => buffer.getChannelData(channel));
  const energies: number[] = [];
  const brightness: number[] = [];

  for (let start = 0; start + frameSize < buffer.length; start += hopSize) {
    let sum = 0;
    let diffSum = 0;
    let previous = 0;

    for (let i = 0; i < frameSize; i += 2) {
      let sample = 0;
      for (const channel of channels) sample += channel[start + i];
      sample /= channelCount;
      sum += sample * sample;
      diffSum += Math.abs(sample - previous);
      previous = sample;
    }

    energies.push(Math.sqrt(sum / (frameSize / 2)));
    brightness.push(diffSum / (frameSize / 2));
  }

  const normalizedEnergy = normalize(energies);
  const normalizedBrightness = normalize(brightness);
  const rawOnsets = normalizedEnergy.map((value, index) => {
    const energyRise = Math.max(0, value - (normalizedEnergy[index - 1] ?? value));
    const brightnessRise = Math.max(0, normalizedBrightness[index] - (normalizedBrightness[index - 1] ?? normalizedBrightness[index]));
    const localEnergy = maxAround(normalizedEnergy, index, 1);
    return energyRise * 0.68 + brightnessRise * 0.26 + localEnergy * 0.06;
  });
  const normalizedOnsets = normalize(rawOnsets.map((value, index) => maxAround(rawOnsets, index, 1) * 0.75 + value * 0.25));

  return normalizedEnergy.map((energy, index) => ({
    timeMs: index * hopSize / sampleRate * 1000,
    energy,
    onset: normalizedOnsets[index],
    brightness: normalizedBrightness[index],
    pitchMidi: null,
    pitchConfidence: 0,
    melodyMidi: null
  }));
}

function compressAudioGuide(frames: AudioFrame[], maxPoints: number): AudioGuidePoint[] {
  if (frames.length <= maxPoints) {
    return frames.map(({ timeMs, energy, onset, brightness }) => ({ timeMs, energy, onset, brightness }));
  }

  const bucketSize = Math.ceil(frames.length / maxPoints);
  const points: AudioGuidePoint[] = [];
  for (let index = 0; index < frames.length; index += bucketSize) {
    const bucket = frames.slice(index, index + bucketSize);
    const strongest = bucket.reduce((best, frame) => {
      const bestScore = best.onset * 0.78 + best.energy * 0.22;
      const score = frame.onset * 0.78 + frame.energy * 0.22;
      return score > bestScore ? frame : best;
    }, bucket[0]);
    points.push({
      timeMs: strongest.timeMs,
      energy: bucket.reduce((max, frame) => Math.max(max, frame.energy), 0),
      onset: bucket.reduce((max, frame) => Math.max(max, frame.onset), 0),
      brightness: bucket.reduce((max, frame) => Math.max(max, frame.brightness), 0)
    });
  }
  return points;
}

function renderProjectPitches(project: Op3SongProject, frames: AudioFrame[], durationMs: number, key: KeyProfile): Op3SongProject {
  return {
    ...project,
    durationMs,
    charts: Object.fromEntries(Object.entries(project.charts).map(([difficulty, chart]) => [
      difficulty,
      {
        ...chart,
        notes: removeTapHoldOverlaps(renderNotePitches(chart.notes, frames, key))
      }
    ])) as Op3SongProject["charts"]
  };
}

function analyzeBuffer(buffer: AudioBuffer): AudioFrame[] {
  const sampleRate = buffer.sampleRate;
  const frameSize = 2048;
  const hopSize = 1024;
  const channelCount = Math.min(buffer.numberOfChannels, 2);
  const channels = Array.from({ length: channelCount }, (_, channel) => buffer.getChannelData(channel));
  const energies: number[] = [];
  const brightness: number[] = [];
  const pitchReadings: Array<{ pitchMidi: number | null; pitchConfidence: number }> = [];

  for (let start = 0; start + frameSize < buffer.length; start += hopSize) {
    let sum = 0;
    let diffSum = 0;
    let previous = 0;

    for (let i = 0; i < frameSize; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[start + i];
      sample /= channelCount;
      sum += sample * sample;
      diffSum += Math.abs(sample - previous);
      previous = sample;
    }

    const rms = Math.sqrt(sum / frameSize);
    energies.push(rms);
    brightness.push(diffSum / frameSize);
    pitchReadings.push(start % (hopSize * 4) === 0
      ? estimatePitch(channels, start, sampleRate, rms)
      : { pitchMidi: null, pitchConfidence: 0 });
  }

  const normalizedEnergy = normalize(energies);
  const normalizedBrightness = normalize(brightness);
  const rawOnsets = normalizedEnergy.map((value, index) => {
    const energyRise = Math.max(0, value - (normalizedEnergy[index - 1] ?? value));
    const brightnessRise = Math.max(0, normalizedBrightness[index] - (normalizedBrightness[index - 1] ?? normalizedBrightness[index]));
    const localEnergy = maxAround(normalizedEnergy, index, 1);
    return energyRise * 0.68 + brightnessRise * 0.26 + localEnergy * 0.06;
  });
  const normalizedOnsets = normalize(rawOnsets.map((value, index) => maxAround(rawOnsets, index, 2) * 0.72 + value * 0.28));

  return normalizedEnergy.map((energy, index) => ({
    timeMs: index * hopSize / sampleRate * 1000,
    energy,
    onset: normalizedOnsets[index],
    brightness: normalizedBrightness[index],
    pitchMidi: pitchReadings[index].pitchMidi,
    pitchConfidence: pitchReadings[index].pitchConfidence,
    melodyMidi: smoothMelodyPitch(pitchReadings, index)
  }));
}

function generateChart(frames: AudioFrame[], project: Op3SongProject, profile: DifficultyProfile, key: KeyProfile, options: GenerateOptions): Op3Note[] {
  const beatMs = 60000 / Math.max(1, project.bpm);
  const stepMs = beatMs / gridDivisionsFor(profile);
  const introMs = Math.max(0, Math.round(project.offsetMs));
  const endMs = Math.max(introMs, project.durationMs - Math.round(beatMs * 0.35));
  const melodyMap = buildMelodyMap(frames);
  const density = clamp(options.density, 0.2, 1.25);
  const sensitivity = clamp(options.sensitivity ?? 0.72, 0.15, 1.25);
  const targetNotes = targetNoteCount(project.durationMs, profile, density, sensitivity);
  const holdGapMs = Math.max(90, beatMs * 0.18);

  const candidates = buildRhythmCandidates(frames, profile, beatMs, stepMs, introMs, endMs);
  const selected = selectRhythmCandidates(candidates, profile, beatMs, stepMs, density, sensitivity, targetNotes);
  const arranged = arrangeRhythmCandidates(selected, frames, profile, key, melodyMap, beatMs, stepMs, density, options.trills !== false);
  return cleanPlayableNotes(arranged, frames, profile, beatMs, holdGapMs)
    .sort((a, b) => a.startMs - b.startMs || a.minKey - b.minKey);
}

function gridDivisionsFor(profile: DifficultyProfile): number {
  if (profile.difficulty === "normal") return 2;
  if (profile.difficulty === "hard") return 4;
  if (profile.difficulty === "expert") return 4;
  return 6;
}

function buildRhythmCandidates(
  frames: AudioFrame[],
  profile: DifficultyProfile,
  beatMs: number,
  stepMs: number,
  introMs: number,
  endMs: number
): RhythmCandidate[] {
  const candidates: RhythmCandidate[] = [];
  const stepsPerBeat = Math.max(1, Math.round(beatMs / stepMs));
  const stepsPerBar = stepsPerBeat * 4;
  const radiusMs = Math.max(34, Math.min(96, stepMs * 0.58));

  for (let step = 0, gridMs = introMs; gridMs < endMs; step++, gridMs += stepMs) {
    const peak = peakFrameAround(frames, gridMs, radiusMs);
    if (peak.energy < 0.08 && peak.onset < 0.1) continue;

    const peakDistance = Math.abs(peak.timeMs - gridMs) / radiusMs;
    const slot = positiveModulo(step, stepsPerBar);
    const onBeat = slot % stepsPerBeat === 0;
    const halfBeat = slot % Math.max(1, Math.round(stepsPerBeat / 2)) === 0;
    const downbeat = slot === 0;
    const phraseAccent = positiveModulo(step, stepsPerBar * 4) === stepsPerBar * 2;
    const pulse = localPunchScore(frames, gridMs, radiusMs);
    const motion = melodyMotionScore(frames, peak.timeMs);
    const beatWeight = downbeat ? 0.34 : onBeat ? 0.22 : halfBeat ? 0.1 : 0;
    const score = clamp(
      pulse * 0.72 +
      peak.onset * 0.42 +
      peak.energy * 0.2 +
      peak.brightness * 0.08 +
      motion * 0.2 +
      beatWeight +
      (phraseAccent ? 0.14 : 0) -
      peakDistance * 0.18,
      0,
      2
    );

    candidates.push({
      step,
      gridMs: Math.round(gridMs),
      peakMs: peak.timeMs,
      frame: peak,
      score,
      pulse,
      beatWeight,
      bar: Math.floor(step / stepsPerBar),
      slot,
      onBeat,
      downbeat,
      pitch: nearestReliablePitch(peak, frames)
    });
  }

  return candidates;
}

function selectRhythmCandidates(
  candidates: RhythmCandidate[],
  profile: DifficultyProfile,
  beatMs: number,
  stepMs: number,
  density: number,
  sensitivity: number,
  targetNotes: number
): RhythmCandidate[] {
  if (candidates.length === 0) return [];

  const scoreValues = candidates.map((candidate) => candidate.score);
  const strongFloor = percentile(scoreValues, clamp(0.76 - sensitivity * 0.24 - density * 0.06, 0.42, 0.78));
  const softFloor = percentile(scoreValues, clamp(0.58 - sensitivity * 0.18 - density * 0.04, 0.32, 0.62));
  const maxEvents = Math.max(8, Math.round(targetNotes / notesPerSelectedCandidate(profile, density)));
  const minGapMs = profile.difficulty === "normal" ? beatMs * 0.46 : profile.difficulty === "hard" ? beatMs * 0.24 : profile.difficulty === "expert" ? beatMs * 0.18 : beatMs * 0.14;
  const maxPerBar = Math.round((profile.difficulty === "normal" ? 5 : profile.difficulty === "hard" ? 8 : profile.difficulty === "expert" ? 11 : 13) * (0.75 + density * 0.42));
  const selected: RhythmCandidate[] = [];
  const perBar = new Map<number, number>();

  const ranked = [...candidates]
    .filter((candidate) => candidate.score >= (candidate.onBeat ? softFloor : strongFloor))
    .sort((a, b) => b.score - a.score || a.gridMs - b.gridMs);

  for (const candidate of ranked) {
    if (selected.length >= maxEvents) break;
    if ((perBar.get(candidate.bar) ?? 0) >= maxPerBar) continue;
    const nearby = selected.find((other) => Math.abs(other.gridMs - candidate.gridMs) < minGapMs);
    if (nearby && candidate.score < nearby.score + 0.18) continue;
    selected.push(candidate);
    perBar.set(candidate.bar, (perBar.get(candidate.bar) ?? 0) + 1);
  }

  const backfilled = backfillImportantBeats(candidates, selected, profile, beatMs, stepMs, softFloor, maxPerBar);
  return backfilled.sort((a, b) => a.gridMs - b.gridMs);
}

function backfillImportantBeats(
  candidates: RhythmCandidate[],
  selected: RhythmCandidate[],
  profile: DifficultyProfile,
  beatMs: number,
  stepMs: number,
  floor: number,
  maxPerBar: number
): RhythmCandidate[] {
  const filled = [...selected];
  const perBar = new Map<number, number>();
  for (const candidate of filled) perBar.set(candidate.bar, (perBar.get(candidate.bar) ?? 0) + 1);
  const minGap = profile.difficulty === "normal" ? beatMs * 0.55 : beatMs * 0.34;

  for (const candidate of candidates.filter((entry) => entry.onBeat && entry.score >= floor).sort((a, b) => a.gridMs - b.gridMs)) {
    if ((perBar.get(candidate.bar) ?? 0) >= maxPerBar) continue;
    if (filled.some((entry) => Math.abs(entry.gridMs - candidate.gridMs) < minGap)) continue;
    if (candidate.pulse < 0.22 && candidate.frame.energy < 0.26) continue;
    filled.push(candidate);
    perBar.set(candidate.bar, (perBar.get(candidate.bar) ?? 0) + 1);
  }

  return filled;
}

function arrangeRhythmCandidates(
  candidates: RhythmCandidate[],
  frames: AudioFrame[],
  profile: DifficultyProfile,
  key: KeyProfile,
  melodyMap: MelodyMap,
  beatMs: number,
  stepMs: number,
  density: number,
  allowTrills: boolean
): Op3Note[] {
  const notes: Op3Note[] = [];
  const composites: Op3Note[] = [];
  const previousPitch: Record<Op3Hand, number | null> = { left: null, right: null, both: null };
  const lastHandMs: Record<Op3Hand, number> = { left: -Infinity, right: -Infinity, both: -Infinity };
  const holdGapMs = Math.max(90, beatMs * 0.18);
  const trillRanges = allowTrills ? detectCandidateTrillRanges(candidates, profile, beatMs, stepMs, density) : [];

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    if (trillRanges.some((range) => index > range.startIndex && index <= range.endIndex)) continue;
    const trillRange = trillRanges.find((range) => range.startIndex === index);
    if (trillRange) {
      const trill = makeCandidateTrill(trillRange, candidates, profile, key, melodyMap);
      if (!composites.some((composite) => reservedOverlap(trill, composite, holdGapMs))) {
        notes.push(trill);
        composites.push(trill);
      }
      continue;
    }

    const hand = chooseCandidateHand(candidate, profile, lastHandMs);
    const pitch = smoothPlayablePitch(candidatePitch(candidate, hand, frames, key, melodyMap), previousPitch[hand], hand, key);
    const holdBeats = candidateHoldBeats(candidate, candidates[index + 1], frames, profile, beatMs);
    const note = makeNote({
      id: `${profile.difficulty}-rhythm-${candidate.step}-${hand}`,
      startMs: candidate.gridMs,
      durationMs: Math.round(holdBeats > 0 ? holdBeats * beatMs : Math.max(105, beatMs * (profile.difficulty === "normal" ? 0.28 : 0.22))),
      hand,
      width: profile.width,
      center: keyCenterForPitch(hand, pitch, melodyMap),
      pitch
    });

    if (notesOverlapAny(note, composites)) continue;
    if (note.type === "hold" && holdConflictsAny(note, composites, holdGapMs)) continue;

    notes.push(note);
    previousPitch[hand] = pitch;
    lastHandMs[hand] = candidate.gridMs;
    if (note.type === "hold") composites.push(note);

    const companion = maybeCandidateCompanion(candidate, note, frames, profile, key, melodyMap, beatMs, density, previousPitch);
    if (companion && !notesOverlapAny(companion, composites) && !notes.some((existing) => Math.abs(existing.startMs - companion.startMs) < 28 && existing.hand === companion.hand)) {
      notes.push(companion);
      previousPitch[companion.hand] = companion.pitch;
      lastHandMs[companion.hand] = companion.startMs;
    }
  }

  return notes;
}

function notesPerSelectedCandidate(profile: DifficultyProfile, density: number): number {
  if (profile.difficulty === "normal") return 1.02 + density * 0.06;
  if (profile.difficulty === "hard") return 1.08 + density * 0.1;
  if (profile.difficulty === "expert") return 1.15 + density * 0.15;
  return 1.22 + density * 0.18;
}

function chooseCandidateHand(candidate: RhythmCandidate, profile: DifficultyProfile, lastHandMs: Record<Op3Hand, number>): Op3Hand {
  const brightMelody = candidate.frame.brightness > 0.57 || candidate.pitch !== null && candidate.pitch >= 58;
  if (profile.difficulty === "normal") {
    if (candidate.downbeat && candidate.frame.brightness < 0.52) return "left";
    if (brightMelody) return "right";
    return candidate.gridMs - lastHandMs.left > candidate.gridMs - lastHandMs.right ? "left" : "right";
  }

  if (candidate.downbeat && candidate.pulse > 0.45 && candidate.frame.brightness < 0.58) return "left";
  if (brightMelody && candidate.gridMs - lastHandMs.right > 80) return "right";
  return candidate.gridMs - lastHandMs.left > candidate.gridMs - lastHandMs.right ? "left" : "right";
}

function candidatePitch(candidate: RhythmCandidate, hand: Op3Hand, frames: AudioFrame[], key: KeyProfile, melodyMap: MelodyMap): number {
  if (hand === "left" && (candidate.downbeat || candidate.frame.brightness < 0.5)) {
    return accompanimentPitch(candidate.step, key, candidate.frame);
  }
  return contourPitchFor(hand === "left" ? "both" : hand, candidate.peakMs, candidate.step, candidate.frame, frames, key, melodyMap);
}

function candidateHoldBeats(candidate: RhythmCandidate, next: RhythmCandidate | undefined, frames: AudioFrame[], profile: DifficultyProfile, beatMs: number): number {
  if (candidate.frame.onset > 0.46 || candidate.pulse > 0.68) return 0;
  if (candidate.score < (profile.difficulty === "normal" ? 0.72 : 0.82)) return 0;
  const sustained = sustainedToneBeats(frames, candidate.peakMs, beatMs);
  if (sustained < 1.45) return 0;
  const untilNext = next ? (next.gridMs - candidate.gridMs) / beatMs - 0.18 : sustained;
  const capped = Math.min(sustained, Math.max(0, untilNext));
  if (capped < 1.2) return 0;
  if (profile.difficulty === "normal") return clamp(capped, 1.25, 2.5);
  if (profile.difficulty === "hard") return clamp(capped, 1.15, 2.0);
  return clamp(capped, 1.05, 1.6);
}

function maybeCandidateCompanion(
  candidate: RhythmCandidate,
  primary: Op3Note,
  frames: AudioFrame[],
  profile: DifficultyProfile,
  key: KeyProfile,
  melodyMap: MelodyMap,
  beatMs: number,
  density: number,
  previousPitch: Record<Op3Hand, number | null>
): Op3Note | null {
  if (primary.type !== "tap") return null;
  if (!candidate.downbeat && !(candidate.onBeat && candidate.score > 1.05)) return null;
  if (profile.difficulty === "normal" && density < 0.78) return null;
  if (profile.difficulty === "hard" && density < 0.48) return null;
  const hand: Op3Hand = primary.hand === "left" ? "right" : "left";
  const rawPitch = hand === "left" ? accompanimentPitch(candidate.step + 2, key, candidate.frame) : harmonyPitchFor(hand, candidate.step + 3, candidate.frame, frames, key, melodyMap);
  const pitch = smoothPlayablePitch(rawPitch, previousPitch[hand], hand, key);
  return makeNote({
    id: `${profile.difficulty}-rhythm-${candidate.step}-${hand}-accent`,
    startMs: candidate.gridMs,
    durationMs: Math.round(beatMs * 0.2),
    hand,
    width: profile.width,
    center: keyCenterForPitch(hand, pitch, melodyMap),
    pitch
  });
}

function detectCandidateTrillRanges(candidates: RhythmCandidate[], profile: DifficultyProfile, beatMs: number, stepMs: number, density: number): Array<{ startIndex: number; endIndex: number }> {
  if (profile.difficulty === "normal" || density < 0.6) return [];
  const minRun = profile.difficulty === "hard" ? 5 : 4;
  const maxGap = Math.min(beatMs * 0.4, stepMs * 1.25);
  const ranges: Array<{ startIndex: number; endIndex: number }> = [];

  for (let index = 0; index < candidates.length - minRun; index++) {
    const run = [index];
    while (run[run.length - 1] + 1 < candidates.length) {
      const prev = candidates[run[run.length - 1]];
      const nextIndex = run[run.length - 1] + 1;
      const next = candidates[nextIndex];
      if (next.gridMs - prev.gridMs > maxGap) break;
      if (next.score < 0.72 || prev.score < 0.72) break;
      const prevPitch = prev.pitch ?? prev.frame.melodyMidi;
      const nextPitch = next.pitch ?? next.frame.melodyMidi;
      const alternates = prevPitch !== null && nextPitch !== null
        ? Math.abs(prevPitch - nextPitch) >= 2 && Math.abs(prevPitch - nextPitch) <= 7
        : prev.frame.brightness !== next.frame.brightness;
      if (!alternates) break;
      run.push(nextIndex);
    }
    if (run.length >= minRun) {
      ranges.push({ startIndex: run[0], endIndex: run[run.length - 1] });
      index = run[run.length - 1] + minRun;
    }
  }

  return ranges;
}

function makeCandidateTrill(range: { startIndex: number; endIndex: number }, candidates: RhythmCandidate[], profile: DifficultyProfile, key: KeyProfile, melodyMap: MelodyMap): Op3Note {
  const run = candidates.slice(range.startIndex, range.endIndex + 1);
  const bright = run.reduce((sum, candidate) => sum + candidate.frame.brightness, 0) / run.length;
  const hand: Op3Hand = bright > 0.54 ? "right" : "left";
  const pitches = run.map((candidate) => candidate.pitch ?? candidate.frame.melodyMidi).filter((pitch): pitch is number => pitch !== null);
  const pitch = quantizeToKey(Math.round(pitches.reduce((sum, value) => sum + value, 0) / Math.max(1, pitches.length)) || (hand === "left" ? 42 : 64), key);
  const center = clamp(keyCenterForPitch(hand, pitch, melodyMap), 0, 26);
  return {
    id: `${profile.difficulty}-rhythm-trill-${run[0].step}-${hand}`,
    startMs: run[0].gridMs,
    endMs: Math.max(run[0].gridMs + 220, run[run.length - 1].gridMs),
    hand,
    minKey: center,
    maxKey: center + 1,
    pitch,
    type: "trill"
  };
}

function detectMusicalEvents(
  frames: AudioFrame[],
  profile: DifficultyProfile,
  beatMs: number,
  stepMs: number,
  introMs: number,
  endMs: number,
  density: number,
  sensitivity: number,
  targetNotes: number
): MusicEvent[] {
  const eventStepMs = eventGridStepMs(profile, beatMs, stepMs);
  const candidateRadius = Math.max(32, Math.min(86, eventStepMs * 0.48));
  const raw: MusicEvent[] = [];
  const scores = frames.map((frame) => eventStrength(frames, frame));
  const scoreFloor = percentile(scores, 0.52 - sensitivity * 0.18);

  for (let index = 2; index < frames.length - 2; index++) {
    const frame = frames[index];
    if (frame.timeMs < introMs || frame.timeMs >= endMs) continue;

    const score = scores[index];
    const localMax = Math.max(scores[index - 2], scores[index - 1], scores[index + 1], scores[index + 2]);
    if (score < localMax && frame.onset < 0.82) continue;
    if (score < scoreFloor && frame.onset < 0.54) continue;

    const gridMs = snapGridTime(frame.timeMs, introMs, eventStepMs);
    if (gridMs < introMs || gridMs >= endMs) continue;
    const distance = Math.abs(frame.timeMs - gridMs);
    const gridPenalty = clamp(distance / Math.max(1, candidateRadius), 0, 1);
    const step = rhythmStepMs(gridMs, introMs, eventStepMs);
    const beatSlot = Math.round((gridMs - introMs) / beatMs);
    const downbeat = positiveModulo(beatSlot, 4) === 0 && Math.abs(gridMs - (introMs + beatSlot * beatMs)) < eventStepMs * 0.25;
    const onBeat = Math.abs(gridMs - (introMs + beatSlot * beatMs)) < eventStepMs * 0.25;
    const accent = clamp(score + (downbeat ? 0.34 : onBeat ? 0.2 : 0) - gridPenalty * 0.2, 0, 1.8);
    const pitch = nearestReliablePitch(frame, frames);
    const handHint: Op3Hand = frame.brightness > 0.58 || pitch !== null && pitch >= 58 ? "right" : "left";
    raw.push({ timeMs: frame.timeMs, gridMs, step, frame, score: accent, accent, pitch, handHint, onBeat, downbeat });
  }

  const deduped = new Map<number, MusicEvent>();
  for (const event of raw) {
    const existing = deduped.get(event.step);
    if (!existing || event.score > existing.score) deduped.set(event.step, event);
  }

  const candidates = [...deduped.values()].sort((a, b) => b.score - a.score || a.gridMs - b.gridMs);
  const maxEvents = Math.round(targetNotes / notesPerEvent(profile, density));
  const minGapMs = profile.difficulty === "normal" ? beatMs * 0.46 : profile.difficulty === "hard" ? beatMs * 0.31 : profile.difficulty === "expert" ? beatMs * 0.22 : beatMs * 0.18;
  const maxPerBarBase = profile.difficulty === "normal" ? 6 : profile.difficulty === "hard" ? 8 : profile.difficulty === "expert" ? 11 : 13;
  const maxPerBar = Math.max(3, Math.round(maxPerBarBase * (0.72 + density * 0.46)));
  const chosen: MusicEvent[] = [];
  const perBar = new Map<number, number>();

  for (const candidate of candidates) {
    if (chosen.length >= maxEvents) break;
    const bar = Math.floor((candidate.gridMs - introMs) / (beatMs * 4));
    if ((perBar.get(bar) ?? 0) >= maxPerBar) continue;
    if (chosen.some((event) => Math.abs(event.gridMs - candidate.gridMs) < minGapMs && candidate.score < event.score + 0.18)) continue;
    chosen.push(candidate);
    perBar.set(bar, (perBar.get(bar) ?? 0) + 1);
  }

  return chosen.sort((a, b) => a.gridMs - b.gridMs);
}

function arrangeEventNotes(
  events: MusicEvent[],
  frames: AudioFrame[],
  profile: DifficultyProfile,
  key: KeyProfile,
  melodyMap: MelodyMap,
  beatMs: number,
  stepMs: number,
  density: number,
  allowTrills: boolean
): Op3Note[] {
  const notes: Op3Note[] = [];
  const composites: Op3Note[] = [];
  const previousPitch: Record<Op3Hand, number | null> = { left: null, right: null, both: null };
  const lastHandAtBeat: Record<Op3Hand, number> = { left: -Infinity, right: -Infinity, both: -Infinity };
  const holdGapMs = Math.max(90, beatMs * 0.18);
  const trillRanges = allowTrills ? detectEventTrillRanges(events, profile, beatMs, stepMs, density) : [];

  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (trillRanges.some((range) => index > range.startIndex && index <= range.endIndex)) continue;
    const trillRange = trillRanges.find((range) => range.startIndex === index);
    if (trillRange) {
      const trill = makeEventTrill(trillRange, events, profile, key, melodyMap);
      if (!composites.some((composite) => reservedOverlap(trill, composite, holdGapMs))) {
        notes.push(trill);
        composites.push(trill);
      }
      continue;
    }

    const hand = chooseMusicalHand(event, profile, lastHandAtBeat);
    const pitch = eventPitch(event, hand, frames, key, melodyMap);
    const smoothed = smoothPlayablePitch(pitch, previousPitch[hand], hand, key);
    const holdBeats = eventHoldBeats(event, frames, profile, beatMs);
    const durationMs = holdBeats > 0 ? beatMs * holdBeats : beatMs * (profile.difficulty === "normal" ? 0.3 : 0.24);
    const note = makeNote({
      id: `${profile.difficulty}-event-led-${event.step}-${hand}`,
      startMs: Math.round(event.gridMs),
      durationMs: Math.round(Math.max(105, durationMs)),
      hand,
      width: profile.width,
      center: keyCenterForPitch(hand, smoothed, melodyMap),
      pitch: smoothed
    });

    if (notesOverlapAny(note, composites)) continue;
    if (note.type === "hold" && holdConflictsAny(note, composites, holdGapMs)) continue;
    notes.push(note);
    previousPitch[hand] = smoothed;
    lastHandAtBeat[hand] = event.gridMs;
    if (note.type === "hold") composites.push(note);

    const chord = maybeCompanionNote(event, note, frames, profile, key, melodyMap, beatMs, density, previousPitch);
    if (chord && !notesOverlapAny(chord, composites) && !notes.some((existing) => Math.abs(existing.startMs - chord.startMs) < 28 && existing.hand === chord.hand)) {
      notes.push(chord);
      previousPitch[chord.hand] = chord.pitch;
    }
  }

  return notes;
}

function eventStrength(frames: AudioFrame[], frame: AudioFrame): number {
  return clamp(
    frame.onset * 0.86 +
    frame.energy * 0.22 +
    frame.brightness * 0.12 +
    melodyMotionScore(frames, frame.timeMs) * 0.18,
    0,
    1.8
  );
}

function eventGridStepMs(profile: DifficultyProfile, beatMs: number, stepMs: number): number {
  if (profile.difficulty === "normal") return beatMs / 2;
  if (profile.difficulty === "hard") return beatMs / 3;
  return Math.min(stepMs, beatMs / 4);
}

function notesPerEvent(profile: DifficultyProfile, density: number): number {
  if (profile.difficulty === "normal") return 1.08 + density * 0.1;
  if (profile.difficulty === "hard") return 1.14 + density * 0.14;
  if (profile.difficulty === "expert") return 1.22 + density * 0.18;
  return 1.3 + density * 0.22;
}

function chooseMusicalHand(event: MusicEvent, profile: DifficultyProfile, lastHandAtBeat: Record<Op3Hand, number>): Op3Hand {
  const sinceLeft = event.gridMs - lastHandAtBeat.left;
  const sinceRight = event.gridMs - lastHandAtBeat.right;
  if (profile.difficulty === "normal") {
    if (event.handHint === "right" && sinceRight > sinceLeft * 0.65) return "right";
    if (event.handHint === "left" && sinceLeft > sinceRight * 0.65) return "left";
    return sinceLeft > sinceRight ? "left" : "right";
  }

  if (event.accent > 1.0 && event.frame.brightness < 0.48 && sinceLeft > 120) return "left";
  if (event.frame.brightness > 0.58 || event.pitch !== null && event.pitch >= 58) return sinceRight > 90 ? "right" : "left";
  return sinceLeft > sinceRight ? "left" : "right";
}

function eventPitch(event: MusicEvent, hand: Op3Hand, frames: AudioFrame[], key: KeyProfile, melodyMap: MelodyMap): number {
  if (hand === "left" && event.frame.brightness < 0.52 && event.accent > 0.68) {
    return accompanimentPitch(event.step, key, event.frame);
  }
  return contourPitchFor(hand === "left" ? "both" : hand, event.gridMs, event.step, event.frame, frames, key, melodyMap);
}

function eventHoldBeats(event: MusicEvent, frames: AudioFrame[], profile: DifficultyProfile, beatMs: number): number {
  if (event.handHint === "left" && profile.difficulty === "normal") return 0;
  if (event.frame.onset > 0.5) return 0;
  if (event.accent < (profile.difficulty === "normal" ? 0.62 : 0.7)) return 0;
  const sustained = sustainedToneBeats(frames, event.timeMs, beatMs);
  if (sustained < 1.45) return 0;
  if (profile.difficulty === "normal") return clamp(sustained, 1.35, 2.5);
  if (profile.difficulty === "hard") return clamp(sustained, 1.25, 2.1);
  return clamp(sustained, 1.05, 1.65);
}

function maybeCompanionNote(
  event: MusicEvent,
  primary: Op3Note,
  frames: AudioFrame[],
  profile: DifficultyProfile,
  key: KeyProfile,
  melodyMap: MelodyMap,
  beatMs: number,
  density: number,
  previousPitch: Record<Op3Hand, number | null>
): Op3Note | null {
  if (primary.type !== "tap") return null;
  if (profile.difficulty === "normal" && density < 0.62) return null;
  const downbeatish = event.downbeat || (event.onBeat && event.accent > 1.05);
  const chance = profile.difficulty === "normal" ? 0.18 : profile.difficulty === "hard" ? 0.28 : 0.4;
  if (!downbeatish || event.accent < 0.82 || density < chance) return null;

  const hand: Op3Hand = primary.hand === "left" ? "right" : "left";
  const raw = hand === "left" ? accompanimentPitch(event.step + 2, key, event.frame) : harmonyPitchFor(hand, event.step + 3, event.frame, frames, key, melodyMap);
  const pitch = smoothPlayablePitch(raw, previousPitch[hand], hand, key);
  return makeNote({
    id: `${profile.difficulty}-event-led-${event.step}-${hand}-companion`,
    startMs: Math.round(event.gridMs),
    durationMs: Math.round(beatMs * 0.22),
    hand,
    width: profile.width,
    center: keyCenterForPitch(hand, pitch, melodyMap),
    pitch
  });
}

function detectEventTrillRanges(events: MusicEvent[], profile: DifficultyProfile, beatMs: number, stepMs: number, density: number): Array<{ startIndex: number; endIndex: number }> {
  if (profile.difficulty === "normal" || density < 0.58) return [];
  const minRun = profile.difficulty === "hard" ? 5 : 4;
  const maxGap = Math.min(beatMs * 0.42, stepMs * 1.35);
  const ranges: Array<{ startIndex: number; endIndex: number }> = [];
  let index = 0;

  while (index < events.length - minRun) {
    const run = [index];
    while (run[run.length - 1] + 1 < events.length) {
      const previous = events[run[run.length - 1]];
      const nextIndex = run[run.length - 1] + 1;
      const next = events[nextIndex];
      if (next.gridMs - previous.gridMs > maxGap) break;
      const previousPitch = previous.pitch ?? previous.frame.melodyMidi;
      const nextPitch = next.pitch ?? next.frame.melodyMidi;
      const alternating = previousPitch !== null && nextPitch !== null
        ? Math.abs(previousPitch - nextPitch) >= 2 && Math.abs(previousPitch - nextPitch) <= 9
        : previous.handHint !== next.handHint;
      if (!alternating || next.accent < 0.62) break;
      run.push(nextIndex);
    }

    if (run.length >= minRun) {
      ranges.push({ startIndex: run[0], endIndex: run[run.length - 1] });
      index = run[run.length - 1] + minRun;
    } else {
      index++;
    }
  }

  return ranges;
}

function makeEventTrill(range: { startIndex: number; endIndex: number }, events: MusicEvent[], profile: DifficultyProfile, key: KeyProfile, melodyMap: MelodyMap): Op3Note {
  const run = events.slice(range.startIndex, range.endIndex + 1);
  const hand: Op3Hand = run.filter((event) => event.handHint === "right").length >= run.length / 2 ? "right" : "left";
  const pitches = run.map((event) => event.pitch ?? event.frame.melodyMidi).filter((pitch): pitch is number => pitch !== null);
  const pitch = quantizeToKey(Math.round(pitches.reduce((sum, value) => sum + value, 0) / Math.max(1, pitches.length)) || (hand === "left" ? 42 : 64), key);
  const center = clamp(keyCenterForPitch(hand, pitch, melodyMap), 0, 26);
  return {
    id: `${profile.difficulty}-event-trill-${run[0].step}-${hand}`,
    startMs: Math.round(run[0].gridMs),
    endMs: Math.round(Math.max(run[0].gridMs + 220, run[run.length - 1].gridMs)),
    hand,
    minKey: center,
    maxKey: center + 1,
    pitch,
    type: "trill"
  };
}

function planStepNotes(input: {
  profile: DifficultyProfile;
  key: KeyProfile;
  frames: AudioFrame[];
  frame: AudioFrame;
  step: number;
  timeMs: number;
  beatMs: number;
  beat: boolean;
  halfBeat: boolean;
  downbeat: boolean;
  phraseAccent: boolean;
  score: number;
  melodicMotion: number;
  previousPitch: Record<Op3Hand, number | null>;
  melodyMap: MelodyMap;
  density: number;
}): Op3Note[] {
  if (input.profile.difficulty === "normal") return planNormalStep(input);
  if (input.profile.difficulty === "hard") return planHardStep(input);
  return planAdvancedStep(input);
}

function planNormalStep(input: Parameters<typeof planStepNotes>[0]): Op3Note[] {
  const notes: Op3Note[] = [];
  const phraseStep = input.step % (input.profile.subdivisions * 16);
  const barStep = input.step % (input.profile.subdivisions * 4);
  const repeatedMelodySlot = phraseStep % (input.profile.subdivisions * 2) === 0;
  const wantsMelody = input.beat && (
    input.downbeat ||
    input.phraseAccent ||
    repeatedMelodySlot ||
    input.score > 0.5 + (1 - input.density) * 0.2 ||
    input.melodicMotion > 0.5
  );
  const wantsPickup = input.halfBeat && input.density > 0.56 && (input.score > 0.68 || input.melodicMotion > 0.72);
  const wantsBass = input.downbeat || input.phraseAccent || (
    input.density > 0.42 &&
    input.beat &&
    barStep === input.profile.subdivisions * 2 &&
    (input.frame.energy > 0.46 || input.score > 0.74)
  );

  if (wantsBass) {
    notes.push(makeArrangedNote(input, "left", accompanimentPitch(input.step, input.key, input.frame), input.beatMs * 0.42));
  }

  if (wantsMelody || wantsPickup) {
    const raw = contourPitchFor("right", input.timeMs, input.step, input.frame, input.frames, input.key, input.melodyMap);
    const pitch = smoothPlayablePitch(raw, input.previousPitch.right, "right", input.key);
    notes.push(makeArrangedNote(input, "right", pitch, input.beatMs * 0.34));
  }

  if (input.density > 0.92 && input.downbeat && input.frame.energy > 0.62 && input.frame.onset > 0.42) {
    const centerPitch = smoothPlayablePitch(contourPitchFor("both", input.timeMs + input.beatMs * 0.25, input.step + 2, input.frame, input.frames, input.key, input.melodyMap) - 12, input.previousPitch.both, "both", input.key);
    notes.push(makeArrangedNote(input, "both", centerPitch, input.beatMs * 0.36));
  }

  return notes;
}

function planHardStep(input: Parameters<typeof planStepNotes>[0]): Op3Note[] {
  const notes: Op3Note[] = [];
  const wantsMelody = input.beat || input.score > input.profile.threshold + (1 - input.density) * 0.14 || input.melodicMotion > 0.48;
  const wantsBass = input.downbeat || input.phraseAccent || (input.density > 0.45 && input.beat && input.step % input.profile.subdivisions === 0 && input.frame.energy > 0.48);

  if (wantsBass) {
    notes.push(makeArrangedNote(input, "left", accompanimentPitch(input.step, input.key, input.frame), input.beatMs * 0.36));
  }

  if (wantsMelody) {
    const hand: Op3Hand = input.frame.brightness > 0.62 && !input.beat ? "right" : chooseHand(input.step, input.frame, input.profile);
    const raw = hand === "left" && input.beat && input.frame.brightness < 0.5
      ? accompanimentPitch(input.step, input.key, input.frame)
      : contourPitchFor(hand === "left" ? "both" : hand, input.timeMs, input.step, input.frame, input.frames, input.key, input.melodyMap);
    notes.push(makeArrangedNote(input, hand, smoothPlayablePitch(raw, input.previousPitch[hand], hand, input.key), input.beatMs * 0.3));
  }

  return notes;
}

function planAdvancedStep(input: Parameters<typeof planStepNotes>[0]): Op3Note[] {
  const notes: Op3Note[] = [];
  const threshold = input.profile.threshold + (1 - input.density) * 0.16;
  const shouldPlace = input.downbeat || input.score >= threshold || (input.beat && input.score >= threshold - 0.1) || (input.phraseAccent && input.frame.energy > 0.32);
  if (!shouldPlace) return notes;

  const hand = chooseHand(input.step, input.frame, input.profile);
  const raw = hand === "left" && input.frame.brightness < 0.5
    ? accompanimentPitch(input.step, input.key, input.frame)
    : contourPitchFor(hand === "left" ? "both" : hand, input.timeMs, input.step, input.frame, input.frames, input.key, input.melodyMap);
  notes.push(makeArrangedNote(input, hand, smoothPlayablePitch(raw, input.previousPitch[hand], hand, input.key), input.beatMs * 0.26));

  const wantsChord = input.density > 0.52 && input.downbeat && input.profile.subdivisions >= 4 && input.frame.energy > 0.58 && input.frame.onset > 0.38;
  const wantsAnswer = input.profile.difficulty === "real" && input.density > 0.72 && input.step % 3 === 0 && input.score > input.profile.threshold + 0.2;
  if (wantsChord || wantsAnswer) {
    const otherHand: Op3Hand = hand === "left" ? "right" : "left";
    const pitch = otherHand === "left" ? accompanimentPitch(input.step + 3, input.key, input.frame) : harmonyPitchFor(otherHand, input.step + 5, input.frame, input.frames, input.key, input.melodyMap);
    notes.push(makeArrangedNote(input, otherHand, smoothPlayablePitch(pitch, input.previousPitch[otherHand], otherHand, input.key), input.beatMs * 0.24));
  }

  return notes;
}

function makeArrangedNote(input: Parameters<typeof planStepNotes>[0], hand: Op3Hand, pitch: number, durationMs: number): Op3Note {
  const holdBeats = arrangedHoldBeats(input.profile, input.step, input.timeMs, input.frames, input.frame, hand, input.beatMs);
  const duration = holdBeats > 0 ? input.beatMs * holdBeats : durationMs;
  return makeNote({
    id: `${input.profile.difficulty}-${input.step}-${hand}-${Math.round(pitch)}`,
    startMs: Math.round(input.timeMs),
    durationMs: Math.round(Math.min(input.beatMs * 3.5, Math.max(105, duration))),
    hand,
    width: input.profile.width,
    center: keyCenterForPitch(hand, pitch, input.melodyMap),
    pitch
  });
}

function arrangedHoldBeats(profile: DifficultyProfile, step: number, timeMs: number, frames: AudioFrame[], frame: AudioFrame, hand: Op3Hand, beatMs: number): number {
  if (hand === "both" || step <= 0) return 0;
  if (profile.difficulty !== "normal" && frame.onset > 0.48) return 0;

  const beatAligned = step % profile.subdivisions === 0;
  const phraseAligned = step % (profile.subdivisions * 4) === 0 || step % (profile.subdivisions * 8) === profile.subdivisions * 4;
  const melodyHand = hand === "right" || profile.difficulty !== "normal";
  if (!beatAligned || !melodyHand) return 0;

  const sustainedBeats = sustainedToneBeats(frames, timeMs, beatMs);
  const strongStart = frame.energy > 0.42 && frame.onset < 0.52;
  const periodicAllow = profile.difficulty === "normal" && step % Math.max(profile.subdivisions * 8, Math.round(profile.holdEvery / 2)) === 0;
  const expressiveAllow = sustainedBeats >= 1.75 && (phraseAligned || periodicAllow || frame.energy > 0.68);

  if (!strongStart || !expressiveAllow) return 0;

  if (profile.difficulty === "normal") return clamp(sustainedBeats, 1.45, 2.75);
  if (profile.difficulty === "hard") return clamp(sustainedBeats, 1.25, 2.25);
  return clamp(sustainedBeats, 1.05, 1.75);
}

function targetNoteCount(durationMs: number, profile: DifficultyProfile, density: number, sensitivity = 0.72): number {
  const minutes = Math.max(0.5, durationMs / 60000);
  const basePerMinute = profile.difficulty === "normal"
    ? 85 + density * 110 + sensitivity * 76
    : profile.difficulty === "hard"
      ? 150 + density * 132 + sensitivity * 88
      : profile.difficulty === "expert"
        ? 245 + density * 140 + sensitivity * 96
      : 320 + density * 170 + sensitivity * 118;
  return Math.round(minutes * basePerMinute);
}

function addPunchAccentNotes(
  notes: Op3Note[],
  frames: AudioFrame[],
  profile: DifficultyProfile,
  key: KeyProfile,
  melodyMap: MelodyMap,
  beatMs: number,
  stepMs: number,
  introMs: number,
  endMs: number,
  density: number,
  sensitivity: number
): Op3Note[] {
  const sorted = [...notes].sort((a, b) => a.startMs - b.startMs || a.minKey - b.minKey);
  const occupied = new Set(sorted.map((note) => `${rhythmStepMs(note.startMs, introMs, stepMs)}-${note.hand}`));
  const additions: Op3Note[] = [];
  const minGapMs = profile.difficulty === "normal" ? beatMs * 0.72 : profile.difficulty === "hard" ? beatMs * 0.45 : beatMs * 0.28;
  const maxAdditions = Math.round(targetNoteCount(endMs - introMs, profile, density, sensitivity) * (profile.difficulty === "normal" ? 0.16 : 0.22));
  let lastAccentMs = -Infinity;

  const candidates = frames
    .filter((frame, index) => {
      if (frame.timeMs < introMs || frame.timeMs > endMs) return false;
      const prev = frames[index - 1]?.onset ?? 0;
      const next = frames[index + 1]?.onset ?? 0;
      return frame.onset >= prev && frame.onset >= next;
    })
    .map((frame) => {
      const gridTime = snapGridTime(frame.timeMs, introMs, stepMs);
      const beatDistance = Math.abs(frame.timeMs - gridTime) / Math.max(1, stepMs);
      const beatIndex = Math.round((gridTime - introMs) / beatMs);
      const score = frame.onset * 0.82 + frame.energy * 0.22 + frame.brightness * 0.08 - beatDistance * 0.18 + (beatIndex % 4 === 0 ? 0.18 : 0);
      return { frame, gridTime, score };
    })
    .filter((candidate) => {
      if (candidate.gridTime < introMs || candidate.gridTime > endMs) return false;
      const beatStep = Math.round((candidate.gridTime - introMs) / beatMs);
      const onBeat = Math.abs(candidate.gridTime - (introMs + beatStep * beatMs)) <= stepMs * 0.2;
      const thresholdShift = (sensitivity - 0.72) * 0.18;
      if (profile.difficulty === "normal") return candidate.score > 0.72 - thresholdShift && (onBeat || density > 0.62);
      if (profile.difficulty === "hard") return candidate.score > 0.61 - thresholdShift;
      return candidate.score > 0.5 - thresholdShift;
    })
    .sort((a, b) => b.score - a.score);

  for (const candidate of candidates) {
    if (additions.length >= maxAdditions) break;
    if (Math.abs(candidate.gridTime - lastAccentMs) < minGapMs) continue;
    const step = rhythmStepMs(candidate.gridTime, introMs, stepMs);
    const hand = chooseHand(step, candidate.frame, profile);
    if (occupied.has(`${step}-${hand}`)) continue;
    const raw = hand === "left" && candidate.frame.brightness < 0.5
      ? accompanimentPitch(step, key, candidate.frame)
      : contourPitchFor(hand === "left" ? "both" : hand, candidate.gridTime, step, candidate.frame, frames, key, melodyMap);
    const note = makeNote({
      id: `${profile.difficulty}-punch-${step}-${hand}`,
      startMs: Math.round(candidate.gridTime),
      durationMs: Math.round(beatMs * (profile.difficulty === "normal" ? 0.32 : 0.24)),
      hand,
      width: profile.width,
      center: keyCenterForPitch(hand, raw, melodyMap),
      pitch: quantizeToKey(raw, key)
    });
    if (sorted.some((existing) => notesOverlap(note, existing)) || additions.some((existing) => notesOverlap(note, existing))) continue;
    additions.push(note);
    occupied.add(`${step}-${hand}`);
    lastAccentMs = candidate.gridTime;
  }

  return additions.length > 0 ? [...sorted, ...additions] : sorted;
}

function addBeatSupportNotes(
  notes: Op3Note[],
  frames: AudioFrame[],
  profile: DifficultyProfile,
  key: KeyProfile,
  melodyMap: MelodyMap,
  beatMs: number,
  stepMs: number,
  introMs: number,
  endMs: number,
  density: number,
  sensitivity: number
): Op3Note[] {
  const sorted = [...notes].sort((a, b) => a.startMs - b.startMs || a.minKey - b.minKey);
  const additions: Op3Note[] = [];
  const maxAdditions = Math.round(targetNoteCount(endMs - introMs, profile, density, sensitivity) * (
    profile.difficulty === "normal" ? 0.22 : profile.difficulty === "hard" ? 0.28 : 0.34
  ));
  const minNearbyGapMs = profile.difficulty === "normal" ? beatMs * 0.46 : profile.difficulty === "hard" ? beatMs * 0.3 : stepMs * 0.75;
  const supportEverySteps = profile.difficulty === "normal" ? profile.subdivisions : Math.max(1, Math.round(profile.subdivisions / 2));
  const scoreFloor = (profile.difficulty === "normal" ? 0.58 : profile.difficulty === "hard" ? 0.52 : profile.difficulty === "expert" ? 0.45 : 0.4) - (sensitivity - 0.72) * 0.16;
  const allNotes = () => [...sorted, ...additions];

  for (let step = 0, gridTime = introMs; gridTime < endMs; step++, gridTime += stepMs) {
    if (additions.length >= maxAdditions) break;
    if (step % supportEverySteps !== 0) continue;

    const beatSlot = step % profile.subdivisions === 0;
    const downbeat = step % (profile.subdivisions * 4) === 0;
    const halfBar = step % (profile.subdivisions * 4) === profile.subdivisions * 2;
    const phraseAccent = step % (profile.subdivisions * 16) === profile.subdivisions * 8;
    if (profile.difficulty === "normal" && !beatSlot) continue;

    const frame = peakFrameAround(frames, gridTime, stepMs * 0.82);
    const punch = localPunchScore(frames, gridTime, stepMs * 0.95);
    const score = punch * 0.78 + frame.energy * 0.18 + frame.brightness * 0.06
      + (beatSlot ? 0.08 : 0) + (downbeat ? 0.14 : 0) + (halfBar || phraseAccent ? 0.08 : 0);
    if (score < scoreFloor) continue;

    const existingAtPulse = allNotes().filter((note) => Math.abs(note.startMs - gridTime) <= stepMs * 0.42);
    const maxAtPulse = profile.difficulty === "normal" ? (downbeat || phraseAccent ? 2 : 1) : profile.difficulty === "hard" ? 2 : 3;
    if (existingAtPulse.length >= maxAtPulse) continue;
    if (existingAtPulse.some((note) => note.type === "hold" || note.hand === "both")) continue;

    const hand = chooseBeatSupportHand(step, frame, profile, existingAtPulse.map((note) => note.hand));
    if (existingAtPulse.some((note) => note.hand === hand)) continue;
    if (allNotes().some((note) => note.hand === hand && Math.abs(note.startMs - gridTime) < minNearbyGapMs)) continue;

    const raw = hand === "left" && (beatSlot || frame.brightness < 0.52)
      ? accompanimentPitch(step, key, frame)
      : contourPitchFor(hand === "left" ? "both" : hand, gridTime, step, frame, frames, key, melodyMap);
    const note = makeNote({
      id: `${profile.difficulty}-beat-${step}-${hand}`,
      startMs: Math.round(gridTime),
      durationMs: Math.round(beatMs * (profile.difficulty === "normal" ? 0.3 : 0.24)),
      hand,
      width: profile.width,
      center: keyCenterForPitch(hand, raw, melodyMap),
      pitch: quantizeToKey(raw, key)
    });

    if (allNotes().some((existing) => notesOverlap(note, existing))) continue;
    additions.push(note);
  }

  return additions.length > 0 ? [...sorted, ...additions] : sorted;
}

function chooseBeatSupportHand(step: number, frame: AudioFrame, profile: DifficultyProfile, occupiedHands: Op3Hand[]): Op3Hand {
  const occupied = new Set(occupiedHands);
  const preferred: Op3Hand = frame.brightness > 0.58 && step % 2 === 1 ? "right" : chooseHand(step, frame, profile);
  if (!occupied.has(preferred)) return preferred;
  const alternate: Op3Hand = preferred === "left" ? "right" : "left";
  if (!occupied.has(alternate)) return alternate;
  return preferred;
}

function addAudioEventNotes(
  notes: Op3Note[],
  frames: AudioFrame[],
  profile: DifficultyProfile,
  key: KeyProfile,
  melodyMap: MelodyMap,
  beatMs: number,
  stepMs: number,
  introMs: number,
  endMs: number,
  density: number,
  sensitivity: number,
  targetNotes: number
): Op3Note[] {
  const sorted = [...notes].sort((a, b) => a.startMs - b.startMs || a.minKey - b.minKey);
  const additions: Op3Note[] = [];
  const goal = Math.round(targetNotes * (profile.difficulty === "normal" ? 1.08 : profile.difficulty === "hard" ? 1.12 : 1.18));
  const maxAdditions = Math.max(0, goal - sorted.length);
  if (maxAdditions <= 0) return sorted;

  const minGapByHand = profile.difficulty === "normal" ? beatMs * 0.42 : profile.difficulty === "hard" ? stepMs * 0.82 : stepMs * 0.58;
  const candidateRadius = Math.max(24, Math.min(stepMs * 0.44, 84));
  const floor = (profile.difficulty === "normal" ? 0.48 : profile.difficulty === "hard" ? 0.42 : profile.difficulty === "expert" ? 0.36 : 0.32) - (sensitivity - 0.72) * 0.16;
  const slotsPerBeat = profile.difficulty === "normal" ? 2 : profile.difficulty === "hard" ? 3 : profile.difficulty === "expert" ? 4 : 6;
  const eventStepMs = beatMs / slotsPerBeat;
  const allNotes = () => [...sorted, ...additions];
  const candidates: Array<{ timeMs: number; step: number; frame: AudioFrame; score: number; hand: Op3Hand }> = [];

  for (let step = 0, timeMs = introMs; timeMs < endMs; step++, timeMs += eventStepMs) {
    const frame = peakFrameAround(frames, timeMs, candidateRadius);
    const gridTime = introMs + Math.round((frame.timeMs - introMs) / eventStepMs) * eventStepMs;
    if (gridTime < introMs || gridTime >= endMs) continue;

    const phraseStep = Math.round((gridTime - introMs) / eventStepMs);
    const beatSlot = phraseStep % slotsPerBeat === 0;
    const halfBeatSlot = phraseStep % Math.max(1, Math.round(slotsPerBeat / 2)) === 0;
    const downbeat = phraseStep % (slotsPerBeat * 4) === 0;
    const offGridPenalty = Math.abs(frame.timeMs - gridTime) / Math.max(1, candidateRadius);
    const motion = melodyMotionScore(frames, gridTime);
    const score = localPunchScore(frames, gridTime, candidateRadius)
      + frame.onset * 0.5
      + frame.energy * 0.24
      + frame.brightness * 0.14
      + motion * 0.22
      + (beatSlot ? 0.26 : halfBeatSlot ? 0.14 : 0)
      + (downbeat ? 0.18 : 0)
      - offGridPenalty * 0.16;
    if (score < floor) continue;
    if (profile.difficulty === "normal" && !beatSlot && score < floor + 0.24) continue;

    const hand = chooseEventHand(phraseStep, gridTime, frame, profile, allNotes());
    candidates.push({ timeMs: gridTime, step: phraseStep, frame, score, hand });
  }

  candidates.sort((a, b) => b.score - a.score || a.timeMs - b.timeMs);

  for (const candidate of candidates) {
    if (additions.length >= maxAdditions) break;
    const current = allNotes();
    const existingAtPulse = current.filter((note) => Math.abs(note.startMs - candidate.timeMs) <= eventStepMs * 0.36);
    const maxAtPulse = profile.difficulty === "normal" ? (candidate.step % (slotsPerBeat * 4) === 0 && sensitivity > 0.55 ? 2 : 1) : profile.difficulty === "hard" ? 2 : 3;
    if (existingAtPulse.length >= maxAtPulse) continue;
    if (existingAtPulse.some((note) => note.hand === candidate.hand || note.hand === "both" || candidate.hand === "both")) continue;
    if (current.some((note) => note.hand === candidate.hand && Math.abs(note.startMs - candidate.timeMs) < minGapByHand)) continue;

    const raw = candidate.hand === "left" && candidate.frame.brightness < 0.54
      ? accompanimentPitch(candidate.step, key, candidate.frame)
      : contourPitchFor(candidate.hand === "left" ? "both" : candidate.hand, candidate.timeMs, candidate.step, candidate.frame, frames, key, melodyMap);
    const note = makeNote({
      id: `${profile.difficulty}-event-${candidate.step}-${candidate.hand}`,
      startMs: Math.round(candidate.timeMs),
      durationMs: Math.round(beatMs * (profile.difficulty === "normal" ? 0.28 : 0.22)),
      hand: candidate.hand,
      width: profile.width,
      center: keyCenterForPitch(candidate.hand, raw, melodyMap),
      pitch: quantizeToKey(raw, key)
    });

    if (current.some((existing) => notesOverlap(note, existing))) continue;
    additions.push(note);
  }

  return additions.length > 0 ? [...sorted, ...additions] : sorted;
}

function chooseEventHand(step: number, timeMs: number, frame: AudioFrame, profile: DifficultyProfile, notes: Op3Note[]): Op3Hand {
  const nearby = notes.filter((note) => Math.abs(note.startMs - timeMs) <= 45);
  const hasLeft = nearby.some((note) => note.hand === "left" || note.hand === "both");
  const hasRight = nearby.some((note) => note.hand === "right" || note.hand === "both");
  if (hasLeft && !hasRight) return "right";
  if (hasRight && !hasLeft) return "left";
  if (profile.difficulty === "normal") return Math.floor(step / 2) % 2 === 0 ? "left" : "right";
  if (frame.brightness > 0.58) return "right";
  if (frame.energy > 0.58 && step % 3 !== 1) return "left";
  return step % 2 === 0 ? "left" : "right";
}

function addDetectedTrills(
  notes: Op3Note[],
  frames: AudioFrame[],
  profile: DifficultyProfile,
  key: KeyProfile,
  melodyMap: MelodyMap,
  beatMs: number,
  stepMs: number,
  introMs: number,
  endMs: number,
  density: number,
  sensitivity: number
): Op3Note[] {
  if (profile.difficulty === "normal" || density < 0.42) return notes;

  const sorted = [...notes].sort((a, b) => a.startMs - b.startMs || a.minKey - b.minKey);
  const additions: Op3Note[] = [];
  const maxAdditions = profile.difficulty === "hard" ? 6 : profile.difficulty === "expert" ? 10 : 14;
  const minRun = profile.difficulty === "hard" ? 4 : 3;
  const scanStep = profile.difficulty === "hard" ? Math.max(1, Math.round(profile.subdivisions / 2)) : 1;
  const scoreFloor = (profile.difficulty === "hard" ? 0.49 : profile.difficulty === "expert" ? 0.42 : 0.38) - (sensitivity - 0.72) * 0.14;
  const allNotes = () => [...sorted, ...additions];

  for (let startStep = 0; introMs + startStep * stepMs < endMs && additions.length < maxAdditions; startStep += scanStep) {
    const run: Array<{ step: number; timeMs: number; frame: AudioFrame; score: number; center: number; pitch: number; hand: Op3Hand }> = [];
    let previousCenter: number | null = null;

    for (let step = startStep; step < startStep + profile.subdivisions * 2.5; step += scanStep) {
      const timeMs = introMs + step * stepMs;
      if (timeMs >= endMs) break;
      const frame = peakFrameAround(frames, timeMs, stepMs * 0.58);
      const punch = localPunchScore(frames, timeMs, stepMs * 0.62);
      const score = punch * 0.74 + frame.energy * 0.18 + frame.brightness * 0.12;
      if (score < scoreFloor) break;

      const hand = frame.brightness > 0.56 || step % 2 === 1 ? "right" : "left";
      const rawPitch = hand === "left" && frame.brightness < 0.5
        ? accompanimentPitch(step, key, frame)
        : contourPitchFor(hand === "left" ? "both" : hand, timeMs, step, frame, frames, key, melodyMap);
      const center = keyCenterForPitch(hand, rawPitch, melodyMap);
      const movedEnough = previousCenter === null || Math.abs(center - previousCenter) >= 1 || run.length % 2 === 1;
      if (!movedEnough) break;
      run.push({ step, timeMs, frame, score, center, pitch: quantizeToKey(rawPitch, key), hand });
      previousCenter = center;
    }

    if (run.length < minRun) continue;
    const startMs = Math.round(run[0].timeMs);
    const endRunMs = Math.round(run[run.length - 1].timeMs + stepMs * 0.9);
    const avgScore = run.reduce((sum, entry) => sum + entry.score, 0) / run.length;
    if (avgScore < scoreFloor + 0.04) continue;
    if (allNotes().some((note) => note.type === "hold" && note.startMs < endRunMs && note.endMs > startMs)) continue;
    if (allNotes().some((note) => Math.abs(note.startMs - startMs) < beatMs * 0.5 && note.type === "trill")) continue;

    const hand: Op3Hand = run.filter((entry) => entry.hand === "right").length >= run.length / 2 ? "right" : "left";
    const center = clamp(Math.round(run.reduce((sum, entry) => sum + entry.center, 0) / run.length), 0, 26);
    additions.push({
      id: `${profile.difficulty}-detected-trill-${startStep}-${hand}`,
      startMs,
      endMs: Math.max(startMs + stepMs * minRun, endRunMs),
      hand,
      minKey: center,
      maxKey: center + 1,
      pitch: Math.round(run.reduce((sum, entry) => sum + entry.pitch, 0) / run.length),
      type: "trill"
    });
    startStep += run.length * scanStep;
  }

  if (additions.length === 0) return sorted;
  const filtered = sorted.filter((note) => !additions.some((trill) => trillConsumesNote(trill, note)));
  return [...filtered, ...additions];
}

function convertTrillRuns(notes: Op3Note[], profile: DifficultyProfile, beatMs: number, stepMs: number, density: number): Op3Note[] {
  if (profile.difficulty === "normal" || density < 0.45) return notes;

  const sorted = [...notes].sort((a, b) => a.startMs - b.startMs || handPriority(a.hand) - handPriority(b.hand));
  const consumed = new Set<string>();
  const trills: Op3Note[] = [];
  const minRunLength = profile.difficulty === "hard" ? 5 : 4;
  const maxGap = stepMs * 1.35;

  for (let index = 0; index < sorted.length; index++) {
    const seed = sorted[index];
    if (consumed.has(seed.id) || seed.type !== "tap" || seed.hand === "both") continue;

    const run = [seed];
    for (let cursor = index + 1; cursor < sorted.length; cursor++) {
      const candidate = sorted[cursor];
      const previous = run[run.length - 1];
      if (consumed.has(candidate.id) || candidate.type !== "tap" || candidate.hand !== seed.hand) continue;
      if (candidate.startMs - previous.startMs > maxGap) break;
      const alternating = Math.abs(candidate.pitch - previous.pitch) >= 1.8 || Math.abs(noteKeyCenter(candidate) - noteKeyCenter(previous)) >= 2;
      const nearby = Math.abs(candidate.pitch - seed.pitch) <= 8 || Math.abs(noteKeyCenter(candidate) - noteKeyCenter(seed)) <= 5;
      if (!alternating || !nearby) continue;
      run.push(candidate);
    }

    if (run.length < minRunLength) continue;
    const runStart = run[0].startMs;
    const runEnd = Math.max(...run.map((note) => note.endMs), run[run.length - 1].startMs + stepMs);
    const center = clamp(Math.round(run.reduce((sum, note) => sum + noteKeyCenter(note), 0) / run.length), 0, 26);
    trills.push({
      id: `${profile.difficulty}-trill-${runStart}-${seed.hand}`,
      startMs: runStart,
      endMs: Math.round(runEnd),
      hand: seed.hand,
      minKey: center,
      maxKey: center + 1,
      pitch: Math.round(run.reduce((sum, note) => sum + note.pitch, 0) / run.length),
      type: "trill"
    });
    for (const note of run) consumed.add(note.id);
  }

  if (trills.length === 0) return notes;
  return [...sorted.filter((note) => !consumed.has(note.id)), ...trills].sort((a, b) => a.startMs - b.startMs || a.minKey - b.minKey);
}

function noteKeyCenter(note: Pick<Op3Note, "minKey" | "maxKey">): number {
  return Math.round((note.minKey + note.maxKey) / 2);
}

function trillConsumesNote(trill: Op3Note, note: Op3Note): boolean {
  if (note.type !== "tap") return false;
  const sameHand = trill.hand === note.hand || trill.hand === "both" || note.hand === "both";
  const timeInside = note.startMs >= trill.startMs - 35 && note.startMs <= trill.endMs + 35;
  const keyNear = note.minKey <= trill.maxKey + 1 && note.maxKey >= trill.minKey - 1;
  return sameHand && timeInside && keyNear;
}

function alignNotesToTransientPeaks(notes: Op3Note[], frames: AudioFrame[], profile: DifficultyProfile, beatMs: number, stepMs: number, originMs: number): Op3Note[] {
  const maxShiftMs = Math.min(48, stepMs * 0.26);
  const shifted = notes.map((note) => {
    if (note.type === "hold") return note;
    const centerPunch = localPunchScore(frames, note.startMs, Math.max(18, maxShiftMs * 0.55));
    const peak = peakFrameAround(frames, note.startMs, maxShiftMs);
    const peakPunch = localPunchScore(frames, peak.timeMs, Math.max(18, maxShiftMs * 0.55));
    const delta = peak.timeMs - note.startMs;
    const enoughGain = peakPunch > centerPunch + 0.055 || peak.onset > 0.7;
    if (!enoughGain || Math.abs(delta) < 7 || Math.abs(delta) > maxShiftMs) return note;

    const duration = note.endMs - note.startMs;
    const roundedStart = Math.max(0, Math.round(note.startMs + delta));
    return {
      ...note,
      startMs: roundedStart,
      endMs: Math.max(roundedStart + 80, Math.round(roundedStart + duration))
    };
  });

  if (profile.difficulty === "normal") {
    return shifted.map((note) => {
      if (note.type !== "tap") return note;
      const nearestBeat = originMs + Math.round((note.startMs - originMs) / beatMs) * beatMs;
      return Math.abs(note.startMs - nearestBeat) <= 10 ? { ...note, startMs: Math.round(nearestBeat), endMs: Math.round(nearestBeat + note.endMs - note.startMs) } : note;
    });
  }

  return shifted;
}

function curateRhythm(notes: Op3Note[], frames: AudioFrame[], profile: DifficultyProfile, beatMs: number, density: number, originMs: number): Op3Note[] {
  const sorted = [...notes].sort((a, b) => a.startMs - b.startMs || handPriority(a.hand) - handPriority(b.hand));
  const slotMemory = buildRhythmSlotMemory(sorted, frames, profile, beatMs, originMs);
  const kept: Op3Note[] = [];
  const notesAtTime = new Map<number, number>();

  for (const note of sorted) {
    const score = rhythmScore(note, frames, profile, beatMs, density, slotMemory, originMs);
    const step = rhythmStep(note.startMs, beatMs, profile, originMs);
    const slot = positiveModulo(step, profile.subdivisions * 4);
    const beatSlot = slot % profile.subdivisions === 0;
    const downbeat = slot === 0;
    const existing = notesAtTime.get(note.startMs) ?? 0;
    const maxAtTime = profile.difficulty === "normal" ? (downbeat && density > 0.36 ? 2 : 1) : profile.difficulty === "hard" ? 2 : 3;

    if (existing >= maxAtTime && note.type !== "hold") continue;
    if (shouldDropRhythmNote(note, score, beatSlot, downbeat, profile, density)) continue;

    kept.push(note);
    notesAtTime.set(note.startMs, existing + 1);
  }

  return kept.length > 0 ? kept : notes;
}

function buildRhythmSlotMemory(notes: Op3Note[], frames: AudioFrame[], profile: DifficultyProfile, beatMs: number, originMs: number): Map<number, number> {
  const slots = new Map<number, number>();
  const phraseSteps = profile.subdivisions * 16;

  for (const note of notes) {
    const step = rhythmStep(note.startMs, beatMs, profile, originMs);
    const phraseSlot = positiveModulo(step, phraseSteps);
    const frame = frameAt(frames, note.startMs);
    const current = slots.get(phraseSlot) ?? 0;
    const pulse = frame.onset * 0.9 + frame.energy * 0.25 + (note.type === "hold" ? 0.45 : 0);
    slots.set(phraseSlot, current + pulse);
  }

  const max = Math.max(1, ...slots.values());
  for (const [slot, value] of slots) slots.set(slot, value / max);
  return slots;
}

function rhythmScore(note: Op3Note, frames: AudioFrame[], profile: DifficultyProfile, beatMs: number, density: number, slotMemory: Map<number, number>, originMs: number): number {
  const step = rhythmStep(note.startMs, beatMs, profile, originMs);
  const barSteps = profile.subdivisions * 4;
  const phraseSteps = profile.subdivisions * 16;
  const slot = positiveModulo(step, barSteps);
  const phraseSlot = positiveModulo(step, phraseSteps);
  const frame = frameAt(frames, note.startMs);
  const downbeat = slot === 0;
  const beat = slot % profile.subdivisions === 0;
  const halfBeat = slot % Math.max(1, Math.round(profile.subdivisions / 2)) === 0;
  const pickup = phraseSlot === phraseSteps - profile.subdivisions || phraseSlot === phraseSteps - Math.max(1, Math.round(profile.subdivisions / 2));
  const onsetPeak = localOnsetPeak(frames, note.startMs, beatMs / Math.max(2, profile.subdivisions * 1.5));
  const punch = localPunchScore(frames, note.startMs, beatMs / Math.max(2, profile.subdivisions * 1.35));
  const motif = slotMemory.get(phraseSlot) ?? 0;

  return (
    (downbeat ? 1.25 : 0) +
    (beat ? 0.7 : 0) +
    (halfBeat ? 0.28 : 0) +
    (pickup ? 0.34 : 0) +
    (note.type === "hold" ? 1.0 : 0) +
    onsetPeak * (0.72 + density * 0.18) +
    punch * (1.08 + density * 0.32) +
    frame.energy * 0.28 +
    motif * 0.55
  );
}

function shouldDropRhythmNote(note: Op3Note, score: number, beatSlot: boolean, downbeat: boolean, profile: DifficultyProfile, density: number): boolean {
  if (note.type === "hold") return false;
  if (downbeat) return score < (profile.difficulty === "normal" ? 0.82 : 0.68);
  if (profile.difficulty === "normal") {
    if (!beatSlot && density < 0.78 && score < 1.42) return true;
    return score < 1.12 + (1 - density) * 0.26;
  }
  if (profile.difficulty === "hard") {
    return !beatSlot && score < 0.95 + (1 - density) * 0.18;
  }
  return score < 0.62 + (1 - density) * 0.14;
}

function rhythmStep(timeMs: number, beatMs: number, profile: DifficultyProfile, originMs = 0): number {
  return rhythmStepMs(timeMs, originMs, beatMs / profile.subdivisions);
}

function rhythmStepMs(timeMs: number, originMs: number, stepMs: number): number {
  return Math.round((timeMs - originMs) / stepMs);
}

function snapGridTime(timeMs: number, originMs: number, stepMs: number): number {
  return originMs + rhythmStepMs(timeMs, originMs, stepMs) * stepMs;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function localOnsetPeak(frames: AudioFrame[], timeMs: number, radiusMs: number): number {
  const frame = frameAt(frames, timeMs);
  const nearby = frames.filter((candidate) => Math.abs(candidate.timeMs - timeMs) <= radiusMs);
  const localMax = nearby.reduce((max, candidate) => Math.max(max, candidate.onset), 0);
  if (localMax <= 0) return 0;
  const centered = frame.onset / localMax;
  return clamp(frame.onset * 0.65 + centered * 0.35, 0, 1);
}

function peakFrameAround(frames: AudioFrame[], timeMs: number, radiusMs: number): AudioFrame {
  const nearby = frames.filter((candidate) => Math.abs(candidate.timeMs - timeMs) <= radiusMs);
  if (nearby.length === 0) return frameAt(frames, timeMs);
  return nearby.reduce((best, frame) => {
    const bestScore = best.onset * 0.76 + best.energy * 0.22 + best.brightness * 0.02;
    const score = frame.onset * 0.76 + frame.energy * 0.22 + frame.brightness * 0.02;
    return score > bestScore ? frame : best;
  }, nearby[0]);
}

function localPunchScore(frames: AudioFrame[], timeMs: number, radiusMs: number): number {
  const peak = peakFrameAround(frames, timeMs, radiusMs);
  const centerDistance = Math.abs(peak.timeMs - timeMs) / Math.max(1, radiusMs);
  const centered = 1 - clamp(centerDistance, 0, 1) * 0.22;
  return clamp((peak.onset * 0.82 + peak.energy * 0.18) * centered, 0, 1);
}

function thinChart(notes: Op3Note[], frames: AudioFrame[], profile: DifficultyProfile, beatMs: number, targetNotes: number, density: number, originMs: number): Op3Note[] {
  if (notes.length <= targetNotes) return notes;

  const sorted = [...notes].sort((a, b) => a.startMs - b.startMs || handPriority(a.hand) - handPriority(b.hand));
  const kept: Op3Note[] = [];
  const lastKeptByHand: Partial<Record<Op3Hand, Op3Note>> = {};
  const phraseMemory = new Map<string, boolean>();
  const slotMemory = buildRhythmSlotMemory(sorted, frames, profile, beatMs, originMs);

  for (const note of sorted) {
    const beatIndex = Math.round((note.startMs - originMs) / beatMs);
    const downbeat = positiveModulo(beatIndex, 4) === 0;
    const phraseBeat = positiveModulo(beatIndex, 16);
    const frame = frameAt(frames, note.startMs);
    const last = lastKeptByHand[note.hand];
    const repeatedPitch = last && Math.abs(last.pitch - note.pitch) <= 1;
    const repeatedSoon = repeatedPitch && note.startMs - last.startMs < beatMs * (profile.difficulty === "normal" ? 2.5 : 1.4);
    const patternKey = `${note.hand}-${phraseBeat}-${Math.round(note.pitch / 2)}`;
    const phraseRepeated = phraseMemory.has(patternKey);

    const keepRequired = downbeat || note.type === "hold" || note.hand === "left" && phraseBeat % 8 === 0;
    const keepPattern = phraseRepeated && (profile.difficulty !== "normal" || phraseBeat % 2 === 0);
    const keepExpressive = frame.onset > 0.62 || frame.energy > 0.72;
    const lowDensitySkip = density < 0.45 && repeatedPitch && beatIndex % 2 === 1;
    const normalRepeatSkip = profile.difficulty === "normal" && repeatedSoon && !keepRequired && !keepExpressive;

    if (!keepRequired && (lowDensitySkip || normalRepeatSkip)) {
      phraseMemory.set(patternKey, true);
      continue;
    }

    const score = noteImportance(note, frame, beatIndex, profile, density, keepPattern, rhythmScore(note, frames, profile, beatMs, density, slotMemory, originMs));
    kept.push({ ...note, pitch: note.pitch, id: `${note.id}-thin-${kept.length}` });
    lastKeptByHand[note.hand] = note;
    phraseMemory.set(patternKey, true);

    if (kept.length > targetNotes * 1.7 && score < 0.7) {
      kept.pop();
    }
  }

  if (kept.length <= targetNotes) return kept;
  return kept
    .map((note) => {
      const beatIndex = Math.round((note.startMs - originMs) / beatMs);
      return { note, score: noteImportance(note, frameAt(frames, note.startMs), beatIndex, profile, density, false, rhythmScore(note, frames, profile, beatMs, density, slotMemory, originMs)) };
    })
    .sort((a, b) => b.score - a.score || a.note.startMs - b.note.startMs)
    .slice(0, targetNotes)
    .map((entry) => entry.note);
}

function removeTapHoldOverlaps(notes: Op3Note[]): Op3Note[] {
  const holds = notes.filter((note) => note.type === "hold");
  return notes.filter((note) => note.type === "hold" || !holds.some((hold) => notesOverlap(note, hold)));
}

function cleanPlayableNotes(notes: Op3Note[], frames: AudioFrame[], profile: DifficultyProfile, beatMs: number, compositeGapMs: number): Op3Note[] {
  const sorted = [...notes].sort((a, b) => compositePriority(b) - compositePriority(a) || a.startMs - b.startMs || handPriority(a.hand) - handPriority(b.hand));
  const kept: Op3Note[] = [];
  const composites: Op3Note[] = [];
  const notesAtTime = new Map<number, number>();
  const minTapGapByHand = profile.difficulty === "normal" ? beatMs * 0.42 : profile.difficulty === "hard" ? beatMs * 0.22 : beatMs * 0.14;
  const lastByHand: Partial<Record<Op3Hand, Op3Note>> = {};

  for (const raw of sorted) {
    const note = raw.type === "trill" ? normalizeTrillWidth(raw) : raw;
    const isComposite = note.type === "hold" || note.type === "trill";
    const overlapComposite = composites.some((composite) => reservedOverlap(note, composite, compositeGapMs));

    if (isComposite) {
      if (overlapComposite) continue;
      if (composites.some((composite) => composite.hand === note.hand && Math.abs(note.startMs - composite.endMs) < compositeGapMs)) continue;
    } else if (overlapComposite) {
      continue;
    }

    const bucket = Math.round(note.startMs / 25) * 25;
    const currentAtTime = notesAtTime.get(bucket) ?? 0;
    const maxAtTime = profile.difficulty === "normal" ? 2 : profile.difficulty === "hard" ? 2 : 3;
    if (!isComposite && currentAtTime >= maxAtTime) continue;

    const last = lastByHand[note.hand];
    if (!isComposite && last && note.startMs - last.startMs < minTapGapByHand && noteImportance(note, frameAt(frames, note.startMs), Math.round(note.startMs / beatMs), profile, 0.7, false) < 1.35) {
      continue;
    }

    kept.push(note);
    notesAtTime.set(bucket, currentAtTime + 1);
    lastByHand[note.hand] = note;
    if (isComposite) composites.push(note);
  }

  return kept.sort((a, b) => a.startMs - b.startMs || a.minKey - b.minKey);
}

function compositePriority(note: Op3Note): number {
  if (note.type === "hold") return 2;
  if (note.type === "trill") return 1;
  return 0;
}

function normalizeTrillWidth(note: Op3Note): Op3Note {
  const center = clamp(Math.round((note.minKey + note.maxKey) / 2), 0, 26);
  return { ...note, minKey: center, maxKey: center + 1 };
}

function reservedOverlap(a: Op3Note, b: Op3Note, gapMs: number): boolean {
  const timeOverlap = a.startMs < b.endMs + gapMs && a.endMs > b.startMs - gapMs;
  const sharedHand = a.hand === "both" || b.hand === "both" || a.hand === b.hand;
  const keyOverlap = a.minKey <= b.maxKey + 1 && a.maxKey >= b.minKey - 1;
  return timeOverlap && (sharedHand || keyOverlap);
}

function removeHoldConflicts(notes: Op3Note[], holdGapMs: number): Op3Note[] {
  const kept: Op3Note[] = [];
  const keptHolds: Op3Note[] = [];
  for (const note of [...notes].sort((a, b) => a.startMs - b.startMs || a.minKey - b.minKey)) {
    if (note.type === "hold" && holdConflictsAny(note, keptHolds, holdGapMs)) continue;
    kept.push(note);
    if (note.type === "hold") keptHolds.push(note);
  }
  return kept;
}

function noteImportance(note: Op3Note, frame: AudioFrame, beatIndex: number, profile: DifficultyProfile, density: number, keepPattern: boolean, rhythm = 0): number {
  const downbeat = beatIndex % 4 === 0;
  const halfBar = beatIndex % 4 === 2;
  const phrase = beatIndex % 16 === 0 || beatIndex % 16 === 8;
  const handBoost = note.hand === "left" ? 0.18 : note.hand === "both" ? 0.12 : 0.08;
  const difficultyBoost = profile.difficulty === "normal" ? 0 : profile.difficulty === "hard" ? 0.08 : 0.16;
  const punch = clamp(frame.onset * 0.82 + frame.energy * 0.18, 0, 1);
  return (
    (downbeat ? 1.4 : 0) +
    (phrase ? 0.8 : 0) +
    (halfBar ? 0.36 : 0) +
    (note.type === "hold" ? 0.6 : 0) +
    (keepPattern ? 0.46 : 0) +
    frame.onset * (0.55 + density * 0.22) +
    punch * (0.75 + density * 0.24) +
    frame.energy * 0.42 +
    rhythm * 0.46 +
    handBoost +
    difficultyBoost
  );
}

function handPriority(hand: Op3Hand): number {
  if (hand === "left") return 0;
  if (hand === "right") return 1;
  return 2;
}

function makeNote(input: {
  id: string;
  startMs: number;
  durationMs: number;
  hand: Op3Hand;
  width: number;
  center: number;
  pitch: number;
}): Op3Note {
  const halfLeft = Math.floor((input.width - 1) / 2);
  const minKey = clamp(input.center - halfLeft, 0, 27);
  const maxKey = clamp(minKey + input.width - 1, 0, 27);
  return {
    id: input.id,
    startMs: input.startMs,
    endMs: input.startMs + input.durationMs,
    hand: input.hand,
    minKey,
    maxKey,
    pitch: input.pitch,
    type: input.durationMs > 500 ? "hold" : "tap"
  };
}

function frameAt(frames: AudioFrame[], timeMs: number): AudioFrame {
  if (frames.length === 0) return { timeMs, energy: 0, onset: 0, brightness: 0, pitchMidi: null, pitchConfidence: 0, melodyMidi: null };
  const nearest = frames.reduce((best, frame) => Math.abs(frame.timeMs - timeMs) < Math.abs(best.timeMs - timeMs) ? frame : best, frames[0]);
  return nearest;
}

function chooseHand(step: number, frame: AudioFrame, profile: DifficultyProfile): Op3Hand {
  if (profile.difficulty === "normal") return Math.floor(step / 4) % 2 === 0 ? "left" : "right";
  if (frame.brightness > 0.62) return "right";
  if (frame.energy > 0.58 && step % 4 < 2) return "left";
  return step % 2 === 0 ? "left" : "right";
}

function keyCenter(hand: Op3Hand, step: number, frame: AudioFrame, profile: DifficultyProfile): number {
  const left = profile.subdivisions >= 4 ? [5, 8, 10, 12, 7, 11] : [7, 9, 11, 8];
  const right = profile.subdivisions >= 4 ? [16, 18, 21, 23, 17, 20] : [17, 19, 21, 23];
  const palette = hand === "left" ? left : right;
  const offset = Math.round(frame.brightness * 3 + frame.energy * 2);
  return palette[(step + offset) % palette.length];
}

function pitchFor(hand: Op3Hand, step: number, frame: AudioFrame, frames: AudioFrame[], key: KeyProfile): number {
  const detected = nearestReliablePitch(frame, frames);
  if (detected !== null) {
    return fitPitchToHand(detected, hand, key);
  }

  const left = key.allowed.map((pc) => key.root + pc + 24).filter((pitch) => pitch >= 30 && pitch <= 53);
  const right = key.allowed.map((pc) => key.root + pc + 60).filter((pitch) => pitch >= 55 && pitch <= 79);
  const palette = hand === "left" ? left : right;
  return palette[(step + Math.round(frame.brightness * 5)) % palette.length];
}

function harmonyPitchFor(hand: Op3Hand, step: number, frame: AudioFrame, frames: AudioFrame[], key: KeyProfile, melodyMap: MelodyMap): number {
  const root = contourPitchFor(hand, frame.timeMs, step, frame, frames, key, melodyMap);
  const interval = hand === "left" ? -12 : 7;
  return clamp(root + interval, hand === "left" ? 24 : 48, hand === "left" ? 57 : 84);
}

function accompanimentPitch(step: number, key: KeyProfile, frame: AudioFrame): number {
  const degreePattern = frame.energy > 0.62 ? [0, 7, 3, 7, 5, 7] : [0, 7, 5, 7];
  const degree = degreePattern[Math.floor(step / 2) % degreePattern.length];
  let pitch = key.root + degree + 36;
  if (frame.brightness > 0.62) pitch += 12;
  while (pitch > 53) pitch -= 12;
  while (pitch < 28) pitch += 12;
  return quantizeToKey(pitch, key);
}

function nearestReliablePitch(frame: AudioFrame, frames: AudioFrame[]): number | null {
  if (frame.melodyMidi !== null) return frame.melodyMidi;
  if (frame.pitchMidi !== null && frame.pitchConfidence >= 0.34) return frame.pitchMidi;

  const nearby = frames
    .filter((candidate) => (
      candidate.pitchMidi !== null &&
      candidate.pitchConfidence >= 0.34 &&
      Math.abs(candidate.timeMs - frame.timeMs) <= 220
    ))
    .sort((a, b) => Math.abs(a.timeMs - frame.timeMs) - Math.abs(b.timeMs - frame.timeMs));

  if (nearby.length === 0) return null;
  return nearby[0].pitchMidi;
}

function buildMelodyMap(frames: AudioFrame[]): MelodyMap {
  const pitches = frames
    .filter((frame) => frame.energy > 0.12)
    .map((frame) => frame.melodyMidi ?? (frame.pitchConfidence >= 0.34 ? frame.pitchMidi : null))
    .filter((pitch): pitch is number => pitch !== null)
    .sort((a, b) => a - b);

  if (pitches.length < 8) return { low: 48, high: 84, span: 36 };
  const low = pitches[Math.floor(pitches.length * 0.08)];
  const high = pitches[Math.floor(pitches.length * 0.92)];
  const span = Math.max(8, high - low);
  return { low, high, span };
}

function contourPitchFor(hand: Op3Hand, timeMs: number, step: number, frame: AudioFrame, frames: AudioFrame[], key: KeyProfile, melodyMap: MelodyMap): number {
  const detected = nearestReliablePitch(frame, frames);
  if (detected === null) return pitchFor(hand, step, frame, frames, key);

  const normalized = clamp((detected - melodyMap.low) / melodyMap.span, 0, 1);
  const range = contourPitchRange(hand);
  const shaped = range.min + normalized * (range.max - range.min);
  const motion = melodyMotionScore(frames, timeMs);
  const contourLift = motion > 0.34 ? Math.sign(detected - (frameAt(frames, timeMs - 180).melodyMidi ?? detected)) * Math.min(5, motion * 7) : 0;
  return quantizeToKey(Math.round(shaped + contourLift), key);
}

function contourPitchRange(hand: Op3Hand): { min: number; max: number } {
  if (hand === "left") return { min: 30, max: 54 };
  if (hand === "both") return { min: 43, max: 72 };
  return { min: 52, max: 84 };
}

function sustainedToneBeats(frames: AudioFrame[], timeMs: number, beatMs: number): number {
  const candidates = [3.25, 2.75, 2.25, 1.75, 1.35, 1.05];
  for (const beats of candidates) {
    if (sustainedToneScore(frames, timeMs, beatMs * beats) >= 0.54) return beats;
  }
  return 0;
}

function sustainedToneScore(frames: AudioFrame[], timeMs: number, durationMs: number): number {
  const window = frames.filter((frame) => frame.timeMs >= timeMs && frame.timeMs <= timeMs + durationMs);
  if (window.length < 4) return 0;

  const energetic = window.filter((frame) => frame.energy > 0.22 && frame.onset < 0.74);
  if (energetic.length < window.length * 0.58) return 0;

  const voiced = energetic.filter((frame) => frame.melodyMidi !== null || frame.pitchConfidence > 0.24);
  const voicedRatio = voiced.length / Math.max(1, window.length);
  const energyAverage = energetic.reduce((sum, frame) => sum + frame.energy, 0) / energetic.length;
  const onsetCalm = 1 - energetic.reduce((sum, frame) => sum + frame.onset, 0) / energetic.length;

  const pitches = voiced
    .map((frame) => frame.melodyMidi ?? frame.pitchMidi)
    .filter((pitch): pitch is number => pitch !== null);
  const sorted = [...pitches].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const vibratoFriendlyStability = pitches.length === 0
    ? 0
    : pitches.filter((pitch) => Math.abs(pitch - median) <= 6).length / pitches.length;

  return clamp(
    voicedRatio * 0.28 +
    energyAverage * 0.3 +
    onsetCalm * 0.18 +
    vibratoFriendlyStability * 0.24,
    0,
    1
  );
}

function renderNotePitches(notes: Op3Note[], frames: AudioFrame[], key: KeyProfile): Op3Note[] {
  const sorted = [...notes].sort((a, b) => a.startMs - b.startMs || a.minKey - b.minKey);
  let previousRight: number | null = null;
  let previousLeft: number | null = null;
  const melodyMap = buildMelodyMap(frames);
  const rendered = new Map<string, Op3Note>();

  for (const [orderIndex, note] of sorted.entries()) {
    const frame = frameAt(frames, note.startMs);
    const previous = note.hand === "left" ? previousLeft : previousRight;
    const raw = Number.isFinite(note.pitch) ? note.pitch : contourPitchFor(note.hand, note.startMs, Math.max(0, orderIndex), frame, frames, key, melodyMap);
    const pitch = smoothPlayablePitch(raw, previous, note.hand, key);
    const width = note.maxKey - note.minKey + 1;
    const center = keyCenterForPitch(note.hand, pitch, melodyMap);
    const minKey = clamp(center - Math.floor(width / 2), 0, 27);
    const maxKey = clamp(minKey + width - 1, 0, 27);
    if (note.hand === "left") previousLeft = pitch;
    else previousRight = pitch;
    rendered.set(note.id, { ...note, pitch, minKey, maxKey });
  }

  return notes.map((note) => rendered.get(note.id) ?? note);
}

function smoothPlayablePitch(raw: number, previous: number | null, hand: Op3Hand, key: KeyProfile): number {
  if (previous === null) return raw;
  const min = hand === "left" ? 24 : 48;
  const max = hand === "left" ? 57 : 84;
  const candidates = [-24, -12, 0, 12, 24]
    .map((offset) => quantizeToKey(raw + offset, key))
    .filter((pitch) => pitch >= min && pitch <= max)
    .sort((a, b) => {
      const aJump = Math.abs(a - previous);
      const bJump = Math.abs(b - previous);
      const aStepPenalty = aJump <= 2 ? -2 : aJump > 7 ? 6 : 0;
      const bStepPenalty = bJump <= 2 ? -2 : bJump > 7 ? 6 : 0;
      return aJump + aStepPenalty - (bJump + bStepPenalty);
    });
  const best = candidates[0] ?? raw;
  const rawJump = raw - previous;
  if (Math.abs(rawJump) >= 7 && Math.abs(best - previous) <= 2) {
    const expressive = candidates
      .filter((pitch) => Math.sign(pitch - previous) === Math.sign(rawJump) && Math.abs(pitch - previous) >= 4 && Math.abs(pitch - previous) <= 13)
      .sort((a, b) => Math.abs(a - raw) - Math.abs(b - raw))[0];
    if (expressive !== undefined) return expressive;
  }

  if (Math.abs(best - previous) > 14) {
    return quantizeToKey(previous + Math.sign(best - previous) * 8, key);
  }
  return best;
}

function smoothMelodyPitch(readings: Array<{ pitchMidi: number | null; pitchConfidence: number }>, index: number): number | null {
  const nearby = [];
  for (let i = Math.max(0, index - 10); i <= Math.min(readings.length - 1, index + 10); i++) {
    const reading = readings[i];
    if (reading.pitchMidi !== null && reading.pitchConfidence >= 0.3) {
      nearby.push(reading.pitchMidi);
    }
  }

  if (nearby.length < 2) return null;
  nearby.sort((a, b) => a - b);
  return nearby[Math.floor(nearby.length / 2)];
}

function melodyMotionScore(frames: AudioFrame[], timeMs: number): number {
  const current = frameAt(frames, timeMs).melodyMidi;
  const previous = frameAt(frames, timeMs - 180).melodyMidi;
  if (current === null || previous === null) return 0;
  return clamp(Math.abs(current - previous) / 12, 0, 1);
}

function fitPitchToHand(pitch: number, hand: Op3Hand, key: KeyProfile): number {
  const min = hand === "left" ? 24 : 48;
  const max = hand === "left" ? 57 : 84;
  let fitted = quantizeToKey(Math.round(pitch), key);

  while (fitted < min) fitted += 12;
  while (fitted > max) fitted -= 12;
  return clamp(fitted, min, max);
}

function quantizeToKey(midi: number, key: KeyProfile): number {
  const pitchClass = ((midi % 12) + 12) % 12;
  const allowed = key.allowed.map((pc) => (pc + key.root) % 12);
  let best = allowed[0];
  for (const candidate of allowed) {
    const currentDistance = Math.min(Math.abs(candidate - pitchClass), 12 - Math.abs(candidate - pitchClass));
    const bestDistance = Math.min(Math.abs(best - pitchClass), 12 - Math.abs(best - pitchClass));
    if (currentDistance < bestDistance) best = candidate;
  }
  let delta = best - pitchClass;
  if (delta > 6) delta -= 12;
  if (delta < -6) delta += 12;
  return midi + delta;
}

function detectKey(frames: AudioFrame[]): KeyProfile {
  const major = [0, 2, 4, 5, 7, 9, 11];
  const minor = [0, 2, 3, 5, 7, 8, 10];
  let best: KeyProfile & { score: number } = { root: 0, mode: "minor", allowed: minor, score: -Infinity };

  for (let root = 0; root < 12; root++) {
    for (const candidate of [{ mode: "major" as const, allowed: major }, { mode: "minor" as const, allowed: minor }]) {
      let score = 0;
      for (const frame of frames) {
        const pitch = frame.melodyMidi ?? frame.pitchMidi;
        if (pitch === null) continue;
        const pc = ((pitch % 12) + 12) % 12;
        const inKey = candidate.allowed.some((allowed) => (allowed + root) % 12 === pc);
        score += (inKey ? 1 : -0.45) * Math.max(0.2, frame.pitchConfidence) * Math.max(0.25, frame.energy);
      }
      if (score > best.score) best = { ...candidate, root, score };
    }
  }

  return { root: best.root, mode: best.mode, allowed: best.allowed };
}

function keyCenterForPitch(hand: Op3Hand, pitch: number, melodyMap?: MelodyMap): number {
  if (melodyMap) {
    const range = contourPitchRange(hand);
    const normalized = clamp((pitch - range.min) / Math.max(1, range.max - range.min), 0, 1);
    if (hand === "left") return clamp(Math.round(3 + normalized * 10), 3, 13);
    if (hand === "both") return clamp(Math.round(8 + normalized * 11), 8, 19);
    return clamp(Math.round(14 + normalized * 12), 14, 26);
  }

  if (hand === "left") {
    return clamp(Math.round(3 + (pitch - 30) / 27 * 10), 3, 13);
  }
  if (hand === "both") {
    return clamp(Math.round(11 + (pitch - 48) / 24 * 6), 10, 17);
  }
  return clamp(Math.round(15 + (pitch - 55) / 29 * 10), 15, 25);
}

function estimatePitch(
  channels: Float32Array[],
  start: number,
  sampleRate: number,
  rms: number
): { pitchMidi: number | null; pitchConfidence: number } {
  if (rms < 0.006) return { pitchMidi: null, pitchConfidence: 0 };

  const windowSize = 1536;
  const minLag = Math.floor(sampleRate / 900);
  const maxLag = Math.floor(sampleRate / 80);
  const sampleStep = 8;
  let bestLag = 0;
  let bestDifference = Number.POSITIVE_INFINITY;
  let baselineDifference = 0;
  let tested = 0;

  for (let lag = minLag; lag <= maxLag; lag += 2) {
    let difference = 0;
    let count = 0;
    for (let i = 0; i + lag < windowSize; i += sampleStep) {
      const sample = monoSample(channels, start + i);
      const delayed = monoSample(channels, start + i + lag);
      difference += Math.abs(sample - delayed);
      count++;
    }

    const average = difference / Math.max(1, count);
    baselineDifference += average;
    tested++;
    if (average < bestDifference) {
      bestDifference = average;
      bestLag = lag;
    }
  }

  const baseline = baselineDifference / Math.max(1, tested);
  const confidence = clamp((baseline - bestDifference) / Math.max(0.000001, baseline), 0, 1);
  if (!bestLag || confidence < 0.22) return { pitchMidi: null, pitchConfidence: confidence };

  const frequency = sampleRate / bestLag;
  const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
  if (!Number.isFinite(midi) || midi < 24 || midi > 96) return { pitchMidi: null, pitchConfidence: confidence };
  return { pitchMidi: midi, pitchConfidence: confidence };
}

function monoSample(channels: Float32Array[], index: number): number {
  let sample = 0;
  for (const channel of channels) sample += channel[index] ?? 0;
  return sample / channels.length;
}

function shouldHold(step: number, frame: AudioFrame, profile: DifficultyProfile): boolean {
  if (step <= 0 || step % profile.holdEvery !== 0) return false;
  if (profile.difficulty === "normal") return frame.energy > 0.36 && frame.onset < 0.72;
  if (profile.difficulty === "hard") return frame.energy > 0.44 && frame.onset < 0.68;
  return frame.energy > 0.55 && frame.onset < 0.58;
}

function notesOverlapAny(note: Op3Note, notes: Op3Note[]): boolean {
  return notes.some((other) => notesOverlap(note, other));
}

function holdConflictsAny(note: Op3Note, holds: Op3Note[], gapMs: number): boolean {
  return holds.some((hold) => {
    const timeTooClose = note.startMs < hold.endMs + gapMs && note.endMs > hold.startMs - gapMs;
    if (!timeTooClose) return false;
    const sharedHand = note.hand === "both" || hold.hand === "both" || note.hand === hold.hand;
    const nearbyKeys = note.minKey <= hold.maxKey + 1 && note.maxKey >= hold.minKey - 1;
    return sharedHand || nearbyKeys;
  });
}

function pruneHolds(holds: Op3Note[], timeMs: number) {
  for (let i = holds.length - 1; i >= 0; i--) {
    if (holds[i].endMs <= timeMs) holds.splice(i, 1);
  }
}

function normalize(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  const ceiling = sorted[Math.floor(sorted.length * 0.98)] ?? 1;
  const span = Math.max(ceiling - floor, 0.000001);
  return values.map((value) => clamp((value - floor) / span, 0, 1));
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[clamp(Math.round((sorted.length - 1) * ratio), 0, sorted.length - 1)] ?? 0;
}

function maxAround(values: number[], center: number, radius: number): number {
  let best = 0;
  for (let i = Math.max(0, center - radius); i <= Math.min(values.length - 1, center + radius); i++) {
    best = Math.max(best, values[i]);
  }
  return best;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
