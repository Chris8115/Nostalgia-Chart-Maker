import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Op3Difficulty, Op3Hand, Op3Note, Op3SongProject, defaultDescription, difficulties as projectDifficulties, validateProject } from "./shared/project.js";

type Difficulty = {
  suffix: string;
  label: string;
  level: number;
  density: number;
  holdEvery: number;
  octaveEvery: number;
};

type SongConfig = {
  basenameLower: string;
  basenameUpper: string;
  title: string;
  titleKana: string;
  artist: string;
  artistKana: string;
  description: string;
  bpm: number;
  audioPath: string;
  imagePath: string;
  levels: [number, number, number, number];
};

type AudioAnalysis = {
  durationMsec: number;
  frameMsec: number;
  energy: number[];
  novelty: number[];
  pitchMidi: Array<number | null>;
  pitchConfidence: number[];
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

type ChartNote = {
  start: number;
  end: number;
  scale: number;
  minKey: number;
  maxKey: number;
  noteType: number;
  hand: number;
  subNotes: SubNote[];
};

type InstallProjectOptions = {
  uniqueXsb: boolean;
};

const mapperRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(mapperRoot, "..");
const dataRoot = join(repoRoot, "data_op3");
const musicRoot = join(dataRoot, "sound", "music");
const musicListPath = join(dataRoot, "sound", "music_list.xml");
const filepathInfoPath = join(repoRoot, "prop", "filepath.info");
const jacketTemplatePath = join(repoRoot, "data", "jacket", "jkms_l", "afp_jkms0405_l.ifs");
const smallJacketPackPath = join(repoRoot, "data", "jacket", "jkms_s", "afp_jkms040_s.ifs");
const buildJacketScript = join(mapperRoot, "scripts", "build_jacket.py");
const buildSmallJacketScript = join(mapperRoot, "scripts", "build_small_jacket.py");
const scratchRoot = join(mapperRoot, "scratch");
const audioTemplate = {
  basenameLower: "m_t0116_qma_milkywaystar",
  basenameUpper: "M_T0116_qma_milkywaystar"
};
const pcmAudioTemplate = {
  basenameLower: "m_c0074_vivaldi_autumn1",
  basenameUpper: "M_C0074_vivaldi_autumn1"
};
const pcmAudioTemplates = [
  pcmAudioTemplate,
  { basenameLower: "m_n0105_catapultedarch", basenameUpper: "M_N0105_catapultedarch" },
  { basenameLower: "m_t0082_oboro", basenameUpper: "M_T0082_oboro" },
  { basenameLower: "m_n0096_unhappyheart", basenameUpper: "M_N0096_unhappyheart" },
  { basenameLower: "m_l0081_littlecry", basenameUpper: "M_L0081_littlecry" },
  { basenameLower: "m_t0099_littleprayer", basenameUpper: "M_T0099_littleprayer" },
  { basenameLower: "m_c0073_vivaldi_spring1", basenameUpper: "M_C0073_vivaldi_spring1" },
  { basenameLower: "m_n0115_pianotaiso", basenameUpper: "M_N0115_pianotaiso" }
];

const difficulties: Difficulty[] = [
  { suffix: "00normal", label: "normal", level: 4, density: 1, holdEvery: 16, octaveEvery: 8 },
  { suffix: "01hard", label: "hard", level: 7, density: 2, holdEvery: 12, octaveEvery: 6 },
  { suffix: "02extreme", label: "extreme", level: 10, density: 3, holdEvery: 10, octaveEvery: 4 },
  { suffix: "03real", label: "real", level: 13, density: 4, holdEvery: 8, octaveEvery: 3 }
];

function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "install-project") {
    const positionalProjectIndex = args.findIndex((arg) => arg.toLowerCase().endsWith(".op3song.json"));
    const gameDir = readFlag(args, "--game-dir") ?? (positionalProjectIndex > 0 ? args.slice(0, positionalProjectIndex).join(" ") : args[0]);
    const projectPath = readFlag(args, "--project") ?? (positionalProjectIndex >= 0 ? args[positionalProjectIndex] : args[1]);
    if (!gameDir) throw new Error("Missing --game-dir");
    if (!projectPath) throw new Error("Missing --project");
    installProjectPackage(resolve(gameDir), resolve(projectPath), { uniqueXsb: args.includes("--unique-xsb") });
    return;
  }

  if (command === "remove") {
    const basenameArg = readFlag(args, "--basename");
    if (!basenameArg) throw new Error("Missing --basename");
    removeSong(basenameArg);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function printHelp() {
  console.log(`nostalgia-chart-maker

Commands:
  install-project --game-dir "C:\\Games\\Nostalgia OP 3" --project song.op3song.json [--unique-xsb]
  install-project "C:\\Games\\Nostalgia OP 3" song.op3song.json
  remove --basename M_CUSTOM0001_SONGNAME
`);
}

function installSong(config: SongConfig) {
  if (!existsSync(config.audioPath)) {
    throw new Error(`Audio file was not found: ${config.audioPath}`);
  }

  const analysis = analyzeAudio(config.audioPath);
  const durationMsec = analysis?.durationMsec ?? readMp3DurationMsec(config.audioPath) ?? 255000;
  const folder = join(musicRoot, config.basenameLower);
  mkdirSync(folder, { recursive: true });

  for (const difficulty of difficulties) {
    const levelAdjusted = { ...difficulty, level: config.levels[difficulties.indexOf(difficulty)] };
    const xml = buildScoreXml(config, levelAdjusted, durationMsec, analysis);
    writeFileSync(join(folder, `${config.basenameLower}_${difficulty.suffix}.xml`), xml, "utf8");
  }

  copyFileSync(config.audioPath, join(folder, "source.mp3"));
  if (existsSync(config.imagePath)) {
    copyFileSync(config.imagePath, join(folder, "source_jacket.jpg"));
  }
  writeFileSync(
    join(folder, "AUDIO_TODO.txt"),
    [
      "This folder has generated OP3 chart XML, placeholder XACT banks, and the original source.mp3.",
      "",
      "The current .xsb/.xwb files are patched template banks from a built-in song.",
      "They exist so the game can get past file loading while we validate custom charts.",
      "",
      "Next step: generate real XACT banks from source.mp3 with legacy XACT tooling or an XSB/XWB adapter."
    ].join("\r\n"),
    "utf8"
  );
  installPlaceholderAudio(config, folder);

  const musicIndex = registerSong(config);
  installJacket(config, musicIndex);
  console.log(`Installed ${config.basenameUpper}`);
  console.log(`Song folder: ${folder}`);
  console.log(`Detected MP3 duration: ${durationMsec} ms`);
  console.log(`Audio analysis: ${analysis ? "enabled" : "fallback pattern only"}`);
}

function removeSong(basenameUpper: string) {
  const musicIndex = findMusicIndex(readFileSync(musicListPath), basenameUpper);
  unregisterSong(basenameUpper);
  if (musicIndex !== null) {
    removeJacket(musicIndex);
  }

  const folder = join(musicRoot, basenameUpper.toLowerCase());
  if (existsSync(folder)) {
    rmSync(folder, { recursive: true, force: true });
  }

  console.log(`Removed ${basenameUpper}`);
}

function installRealAudio(config: SongConfig) {
  if (!existsSync(config.audioPath)) {
    throw new Error(`Audio file was not found: ${config.audioPath}`);
  }

  const folder = join(musicRoot, config.basenameLower);
  mkdirSync(folder, { recursive: true });
  mkdirSync(scratchRoot, { recursive: true });

  const sourceBase = join(musicRoot, audioTemplate.basenameLower, audioTemplate.basenameLower);
  const targetBase = join(folder, config.basenameLower);

  copyPatchedSoundbank(
    `${sourceBase}.xsb`,
    `${targetBase}.xsb`,
    audioTemplate.basenameUpper,
    config.basenameUpper
  );
  copyPatchedSoundbank(
    `${sourceBase}_pre.xsb`,
    `${targetBase}_pre.xsb`,
    `${audioTemplate.basenameUpper}_pre`,
    `${config.basenameUpper}_pre`
  );

  buildXwbFromAudio(config.audioPath, `${targetBase}.xwb`, config.basenameUpper, { preview: false });
  buildXwbFromAudio(config.audioPath, `${targetBase}_pre.xwb`, `${config.basenameUpper}_pre`, { preview: true });

  console.log(`Installed real ADPCM XWB audio for ${config.basenameUpper}`);
  console.log(`Main audio: ${targetBase}.xwb`);
  console.log(`Preview audio: ${targetBase}_pre.xwb`);
}

function installAliasedRealAudio(config: SongConfig) {
  if (!existsSync(config.audioPath)) {
    throw new Error(`Audio file was not found: ${config.audioPath}`);
  }

  const folder = join(musicRoot, config.basenameLower);
  mkdirSync(folder, { recursive: true });
  mkdirSync(scratchRoot, { recursive: true });

  const sourceBase = join(musicRoot, audioTemplate.basenameLower, audioTemplate.basenameLower);
  const targetBase = join(folder, config.basenameLower);

  copyFileSync(`${sourceBase}.xsb`, `${targetBase}.xsb`);
  copyFileSync(`${sourceBase}_pre.xsb`, `${targetBase}_pre.xsb`);
  buildXwbFromAudio(config.audioPath, `${targetBase}.xwb`, audioTemplate.basenameUpper, { preview: false });
  buildXwbFromAudio(config.audioPath, `${targetBase}_pre.xwb`, `${audioTemplate.basenameUpper}_pre`, { preview: true });

  console.log(`Installed aliased real ADPCM XWB audio for ${config.basenameUpper}`);
  console.log(`Internal XACT bank names are intentionally left as ${audioTemplate.basenameUpper}.`);
}

function installAliasedPcmAudio(config: SongConfig) {
  if (!existsSync(config.audioPath)) {
    throw new Error(`Audio file was not found: ${config.audioPath}`);
  }

  const folder = join(musicRoot, config.basenameLower);
  mkdirSync(folder, { recursive: true });
  mkdirSync(scratchRoot, { recursive: true });

  const sourceBase = join(musicRoot, pcmAudioTemplate.basenameLower, pcmAudioTemplate.basenameLower);
  const targetBase = join(folder, config.basenameLower);

  copyFileSync(`${sourceBase}.xsb`, `${targetBase}.xsb`);
  copyFileSync(`${sourceBase}_pre.xsb`, `${targetBase}_pre.xsb`);
  buildXwbFromAudio(config.audioPath, `${targetBase}.xwb`, pcmAudioTemplate.basenameUpper, { preview: false, codec: "pcm" });
  buildXwbFromAudio(config.audioPath, `${targetBase}_pre.xwb`, `${pcmAudioTemplate.basenameUpper}_pre`, { preview: true, codec: "pcm" });

  console.log(`Installed aliased real PCM XWB audio for ${config.basenameUpper}`);
  console.log(`Internal XACT bank names are intentionally left as ${pcmAudioTemplate.basenameUpper}.`);
}

function notesOverlap(a: Op3Note, b: Op3Note): boolean {
  return (
    a.startMs < b.endMs &&
    a.endMs > b.startMs &&
    a.minKey <= b.maxKey &&
    a.maxKey >= b.minKey
  );
}

function projectPitchAt(analysis: AudioAnalysis | null, msec: number, hand: Op3Hand, step: number, key: KeyProfile = defaultProjectKey()): number {
  const detected = analysis ? detectedPitchAt(analysis, msec) ?? detectedMelodyPitchAt(analysis, msec) : null;
  if (detected !== null) {
    return fitProjectPitchToHand(detected, hand, key);
  }

  return projectFallbackPitchAt(analysis, msec, hand, step, key);
}

function projectFallbackPitchAt(analysis: AudioAnalysis | null, msec: number, hand: Op3Hand, step: number, key: KeyProfile = defaultProjectKey()): number {
  const energy = analysis ? energyAt(analysis, msec) : 0;
  if (hand === "left") {
    return projectAccompanimentPitch(step, key, energy);
  }

  const right = key.allowed.map((pc) => key.root + pc + 60).filter((pitch) => pitch >= 55 && pitch <= 79);
  return right[step % right.length];
}

function detectedProjectMelodyPitchAt(analysis: AudioAnalysis, msec: number): number | null {
  const direct = detectedPitchAt(analysis, msec);
  if (direct !== null) return direct;
  return detectedMelodyPitchAt(analysis, msec);
}

function projectContourPitchFor(hand: Op3Hand, msec: number, detected: number, analysis: AudioAnalysis, key: KeyProfile, melodyMap: MelodyMap): number {
  if (hand === "left") {
    const beatishStep = Math.floor(msec / Math.max(1, analysis.frameMsec * 6));
    return projectAccompanimentPitch(beatishStep, key, energyAt(analysis, msec));
  }

  const normalized = clamp((detected - melodyMap.low) / melodyMap.span, 0, 1);
  const range = hand === "both" ? { min: 43, max: 72 } : { min: 52, max: 80 };
  const previous = detectedProjectMelodyPitchAt(analysis, msec - 180) ?? detected;
  const motion = clamp(Math.abs(detected - previous) / 9, 0, 1);
  const contourLift = motion > 0.28 ? Math.sign(detected - previous) * Math.min(4, motion * 6) : 0;
  return quantizeProjectPitch(Math.round(range.min + normalized * (range.max - range.min) + contourLift), key);
}

function projectAccompanimentPitch(step: number, key: KeyProfile, energy: number): number {
  const degreePattern = energy > 0.58 ? [0, 7, 0, 5, 3, 7, 0, 7] : [0, 7, 0, 5];
  const degree = degreePattern[Math.floor(step / 2) % degreePattern.length];
  let pitch = key.root + degree + 36;
  while (pitch > 52) pitch -= 12;
  while (pitch < 30) pitch += 12;
  return quantizeProjectPitch(pitch, key);
}

function buildProjectMelodyMap(analysis: AudioAnalysis): MelodyMap {
  const pitches = analysis.pitchMidi
    .map((pitch, index) => ({ pitch, confidence: analysis.pitchConfidence[index], energy: analysis.energy[index] }))
    .filter((frame): frame is { pitch: number; confidence: number; energy: number } => (
      frame.pitch !== null &&
      frame.confidence >= 0.3 &&
      frame.energy > 0.12
    ))
    .map((frame) => frame.pitch)
    .sort((a, b) => a - b);

  if (pitches.length < 8) return { low: 48, high: 84, span: 36 };
  const low = pitches[Math.floor(pitches.length * 0.08)];
  const high = pitches[Math.floor(pitches.length * 0.92)];
  return { low, high, span: Math.max(8, high - low) };
}

function energyAt(analysis: AudioAnalysis, msec: number): number {
  const index = clamp(Math.round(msec / analysis.frameMsec), 0, analysis.energy.length - 1);
  return analysis.energy[index] ?? 0;
}

function smoothProjectPlayablePitch(raw: number, previous: number | null, hand: Op3Hand, key: KeyProfile): number {
  if (previous === null) return raw;
  const min = hand === "left" ? 24 : 48;
  const max = hand === "left" ? 57 : 84;
  const candidates = [-24, -12, 0, 12, 24]
    .map((offset) => quantizeProjectPitch(raw + offset, key))
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
    return clamp(quantizeProjectPitch(previous + Math.sign(best - previous) * 8, key), min, max);
  }
  return best;
}

function detectedPitchAt(analysis: AudioAnalysis, msec: number): number | null {
  const center = clamp(Math.round(msec / analysis.frameMsec), 0, analysis.pitchMidi.length - 1);
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let i = Math.max(0, center - 5); i <= Math.min(analysis.pitchMidi.length - 1, center + 5); i++) {
    const pitch = analysis.pitchMidi[i];
    if (pitch === null || analysis.pitchConfidence[i] < 0.32) continue;
    const distance = Math.abs(i - center);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }

  return bestIndex >= 0 ? analysis.pitchMidi[bestIndex] : null;
}

function detectedMelodyPitchAt(analysis: AudioAnalysis, msec: number): number | null {
  const center = clamp(Math.round(msec / analysis.frameMsec), 0, analysis.pitchMidi.length - 1);
  const nearby: number[] = [];
  for (let i = Math.max(0, center - 10); i <= Math.min(analysis.pitchMidi.length - 1, center + 10); i++) {
    const pitch = analysis.pitchMidi[i];
    if (pitch !== null && analysis.pitchConfidence[i] >= 0.28) {
      nearby.push(pitch);
    }
  }

  if (nearby.length < 2) return null;
  nearby.sort((a, b) => a - b);
  return nearby[Math.floor(nearby.length / 2)];
}

function fitProjectPitchToHand(pitch: number, hand: Op3Hand, key: KeyProfile): number {
  const min = hand === "left" ? 24 : 48;
  const max = hand === "left" ? 57 : 84;
  let fitted = quantizeProjectPitch(Math.round(pitch), key);
  while (fitted < min) fitted += 12;
  while (fitted > max) fitted -= 12;
  return clamp(fitted, min, max);
}

function quantizeProjectPitch(midi: number, key: KeyProfile): number {
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

function detectProjectKey(analysis: AudioAnalysis): KeyProfile {
  const major = [0, 2, 4, 5, 7, 9, 11];
  const minor = [0, 2, 3, 5, 7, 8, 10];
  let best: KeyProfile & { score: number } = { ...defaultProjectKey(), score: -Infinity };

  for (let root = 0; root < 12; root++) {
    for (const candidate of [{ mode: "major" as const, allowed: major }, { mode: "minor" as const, allowed: minor }]) {
      let score = 0;
      for (let i = 0; i < analysis.pitchMidi.length; i++) {
        const pitch = analysis.pitchMidi[i];
        if (pitch === null) continue;
        const pc = ((pitch % 12) + 12) % 12;
        const inKey = candidate.allowed.some((allowed) => (allowed + root) % 12 === pc);
        score += (inKey ? 1 : -0.45) * Math.max(0.2, analysis.pitchConfidence[i]) * Math.max(0.25, analysis.energy[i] ?? 0);
      }
      if (score > best.score) best = { root, mode: candidate.mode, allowed: candidate.allowed, score };
    }
  }

  return { root: best.root, mode: best.mode, allowed: best.allowed };
}

function defaultProjectKey(): KeyProfile {
  return { root: 0, mode: "minor", allowed: [0, 2, 3, 5, 7, 8, 10] };
}

function projectKeyCenterForPitch(hand: Op3Hand, pitch: number): number {
  if (hand === "left") {
    return clamp(Math.round(3 + (pitch - 30) / 27 * 10), 3, 13);
  }
  if (hand === "both") {
    return clamp(Math.round(11 + (pitch - 48) / 24 * 6), 10, 17);
  }
  return clamp(Math.round(15 + (pitch - 55) / 29 * 10), 15, 25);
}

function buildProjectSubNotes(note: Op3Note, difficulty: Op3Difficulty, index: number): SubNote[] {
  const start = Math.round(note.startMs);
  const end = Math.round(note.endMs);
  const scale = clamp(Math.round(note.pitch), 12, 96);
  const track = note.hand === "left" ? 2 : 1;
  const velocity = difficulty === "normal" ? (note.type === "hold" ? 28 : 34) : difficulty === "hard" ? (note.type === "hold" ? 36 : 44) : note.type === "hold" ? 52 : 60;
  const subNotes: SubNote[] = [{ start, end, scale, velocity, track }];

  if (difficulty === "normal") {
    return subNotes;
  }

  if (difficulty === "hard" && note.hand !== "left" && index % 6 === 0) {
    subNotes.push({ start, end, scale: clamp(scale - 12, 12, 96), velocity: 32, track });
  }

  if ((difficulty === "expert" || difficulty === "real") && note.hand !== "left" && index % 5 === 0) {
    subNotes.push({ start, end, scale: clamp(scale + 7, 12, 96), velocity: 36, track });
  }

  if (difficulty === "real" && note.hand !== "left" && index % 10 === 0) {
    subNotes.push({ start, end, scale: clamp(scale - 12, 12, 96), velocity: 34, track });
  }

  return subNotes;
}

function installProjectPackage(gameDir: string, projectPath: string, options: InstallProjectOptions = { uniqueXsb: false }) {
  if (!existsSync(gameDir)) throw new Error(`Game directory was not found: ${gameDir}`);
  if (!existsSync(projectPath)) throw new Error(`Project file was not found: ${projectPath}`);

  let project = JSON.parse(readFileSync(projectPath, "utf8")) as Op3SongProject;
  project = removeProjectTapsUnderHolds(project);
  const issues = validateProject(project).filter((issue) => issue.severity === "error");
  if (issues.length > 0) {
    throw new Error(`Project has validation errors:\n${issues.map((issue) => `- ${issue.message}`).join("\n")}`);
  }

  const projectAudioPath = resolveProjectAudioPath(projectPath, project);
  const projectAnalysis = projectAudioPath ? analyzeAudio(projectAudioPath) : null;
  if (projectAnalysis) {
    project = removeProjectTapsUnderHolds(renderInstalledProjectPitches(project, projectAnalysis));
  }

  const gameMusicRoot = join(gameDir, "data_op3", "sound", "music");
  const gameMusicListPath = join(gameDir, "data_op3", "sound", "music_list.xml");
  if (!existsSync(gameMusicRoot) || !existsSync(gameMusicListPath)) {
    throw new Error(`Game directory does not look like an OP3 folder: ${gameDir}`);
  }

  const basenameUpper = project.id;
  const basenameLower = basenameUpper.toLowerCase();
  const songFolder = join(gameMusicRoot, basenameLower);
  mkdirSync(songFolder, { recursive: true });

  for (const difficulty of projectDifficulties) {
    const xml = renderProjectScoreXml(project, difficulty);
    writeFileSync(join(songFolder, `${basenameLower}_${difficultySuffix(difficulty)}.xml`), xml, "utf8");
  }

  const hasSafeJacket = true;
  const musicIndex = registerProjectSong(gameMusicListPath, project, hasSafeJacket);
  installProjectPcmAudio(gameDir, projectPath, project, songFolder, options);
  installProjectJacket(gameDir, projectPath, project, musicIndex, { installSmall: hasSafeJacket });

  console.log(`Installed project ${project.id}`);
  console.log(`Game directory: ${gameDir}`);
  console.log(`Song folder: ${songFolder}`);
}

function removeProjectTapsUnderHolds(project: Op3SongProject): Op3SongProject {
  return {
    ...project,
    charts: Object.fromEntries(Object.entries(project.charts).map(([difficulty, chart]) => [
      difficulty,
      {
        ...chart,
        notes: removeOp3TapsUnderHolds(chart.notes)
      }
    ])) as Op3SongProject["charts"]
  };
}

function removeOp3TapsUnderHolds(notes: Op3Note[]): Op3Note[] {
  const holds = notes.filter((note) => note.type === "hold");
  return notes.filter((note) => note.type === "hold" || !holds.some((hold) => notesOverlap(note, hold)));
}

function resolveProjectAudioPath(projectPath: string, project: Op3SongProject): string | null {
  const audioPath = project.audioPath ? resolve(dirname(projectPath), project.audioPath) : null;
  return audioPath && existsSync(audioPath) ? audioPath : null;
}

function resolveProjectJacketPath(projectPath: string, project: Op3SongProject): string | null {
  const jacketPath = project.jacketPath ? resolve(dirname(projectPath), project.jacketPath) : null;
  return jacketPath && existsSync(jacketPath) ? jacketPath : null;
}

function renderInstalledProjectPitches(project: Op3SongProject, analysis: AudioAnalysis): Op3SongProject {
  return {
    ...project,
    durationMs: analysis.durationMsec,
    charts: Object.fromEntries(Object.entries(project.charts).map(([difficulty, chart]) => [
      difficulty,
      {
        ...chart,
        notes: renderProjectNotePitches(analysis, chart.notes)
      }
    ])) as Op3SongProject["charts"]
  };
}

function renderProjectNotePitches(analysis: AudioAnalysis, notes: Op3Note[]): Op3Note[] {
  const order = [...notes].sort((a, b) => a.startMs - b.startMs || a.minKey - b.minKey);
  const renderedById = new Map<string, Op3Note>();
  const key = detectProjectKey(analysis);
  const melodyMap = buildProjectMelodyMap(analysis);
  let previousLeft: number | null = null;
  let previousRight: number | null = null;

  order.forEach((note, index) => {
    const detected = detectedProjectMelodyPitchAt(analysis, note.startMs);
    const generated = detected !== null
      ? projectContourPitchFor(note.hand, note.startMs, detected, analysis, key, melodyMap)
      : projectFallbackPitchAt(analysis, note.startMs, note.hand, index, key);
    const baked = Number.isFinite(note.pitch) ? note.pitch : generated;
    const raw = detected !== null ? blendExportPitch(baked, generated, note.hand) : baked;
    const previous = note.hand === "left" ? previousLeft : previousRight;
    const pitch = smoothProjectPlayablePitch(raw, previous, note.hand, key);
    renderedById.set(note.id, { ...note, pitch });
    if (note.hand === "left") previousLeft = pitch;
    else previousRight = pitch;
  });

  return notes.map((note) => renderedById.get(note.id) ?? note);
}

function blendExportPitch(baked: number, generated: number, hand: Op3Hand): number {
  if (hand === "left") return generated;
  if (Math.abs(baked - generated) > 7) return generated;
  return Math.round(baked * 0.35 + generated * 0.65);
}

function renderProjectScoreXml(project: Op3SongProject, difficulty: Op3Difficulty): string {
  const chart = project.charts[difficulty];
  const finish = Math.max(project.durationMs + 1250, ...chart.notes.map((note) => note.endMs + 750), 30000);
  const introMsec = Math.max(0, Math.round(60000 / project.bpm * 4 + project.offsetMs));
  const renderedNotes = expandProjectTrills(chart.notes, difficulty, 60000 / project.bpm)
    .slice()
    .sort((a, b) => a.startMs - b.startMs || a.minKey - b.minKey)
    .map((note, index) => renderNote({
      index: index + 1,
      start: Math.round(note.startMs),
      end: Math.round(note.endMs),
      gate: Math.max(1, Math.round(note.endMs - note.startMs)),
      scale: clamp(Math.round(note.pitch), 0, 127),
      minKey: clamp(Math.round(note.minKey), 0, 27),
      maxKey: clamp(Math.round(note.maxKey), 0, 27),
      noteType: note.type === "hold" ? 2 : 0,
      hand: note.hand === "left" ? 1 : note.hand === "right" ? 0 : 2,
      subNotes: buildProjectSubNotes(note, difficulty, index)
    }));

  return [
    '<?xml version="1.0"?>',
    "<music_score>",
    "  <header>",
    '    <max_scale __type="s32">84</max_scale>',
    '    <min_scale __type="s32">24</min_scale>',
    '    <file_version __type="s16">1</file_version>',
    `    <first_bpm __type="s64">${Math.round(project.bpm * 100000)}</first_bpm>`,
    `    <music_finish_time_msec __type="s32">${finish}</music_finish_time_msec>`,
    "  </header>",
    "  <note_data>",
    renderedNotes.join(""),
    "  </note_data>",
    renderEventData(projectSongConfig(project), {
      ...difficulties[projectDifficulties.indexOf(difficulty)],
      level: chart.level
    }, introMsec),
    renderBeatData(projectSongConfig(project), finish),
    renderTrackInfo(),
    renderVelocityZoneData(introMsec, Math.max(introMsec, finish - Math.round(60000 / project.bpm * 2))),
    "</music_score>",
    ""
  ].join("\r\n");
}

function projectSongConfig(project: Op3SongProject): SongConfig {
  return {
    basenameLower: project.id.toLowerCase(),
    basenameUpper: project.id,
    title: project.title,
    titleKana: project.title,
    artist: project.artist,
    artistKana: project.artist,
    description: project.description ?? defaultDescription,
    bpm: project.bpm,
    audioPath: project.audioPath ?? "",
    imagePath: project.jacketPath ?? "",
    levels: [
      project.charts.normal.level,
      project.charts.hard.level,
      project.charts.expert.level,
      project.charts.real.level
    ]
  };
}

function expandProjectTrills(notes: Op3Note[], difficulty: Op3Difficulty, beatMsec: number): Op3Note[] {
  const expanded: Op3Note[] = [];
  const interval = difficulty === "hard" ? beatMsec / 4 : difficulty === "normal" ? beatMsec / 3 : beatMsec / 6;

  for (const note of notes) {
    if (note.type !== "trill") {
      expanded.push(note);
      continue;
    }

    const center = Math.round((note.minKey + note.maxKey) / 2);
    const left = {
      minKey: clamp(Math.min(note.minKey, center - 1), 0, 27),
      maxKey: clamp(Math.max(note.minKey, center - 1), 0, 27)
    };
    const right = {
      minKey: clamp(Math.min(center + 1, note.maxKey), 0, 27),
      maxKey: clamp(Math.max(center + 1, note.maxKey), 0, 27)
    };
    const tapDuration = Math.max(80, Math.round(interval * 0.68));
    let index = 0;
    for (let start = note.startMs; start < note.endMs - tapDuration * 0.4; start += interval, index++) {
      const side = index % 2 === 0 ? left : right;
      expanded.push({
        ...note,
        id: `${note.id}-trill-${index}`,
        startMs: Math.round(start),
        endMs: Math.min(note.endMs, Math.round(start + tapDuration)),
        minKey: side.minKey,
        maxKey: side.maxKey,
        pitch: note.pitch + (index % 2 === 0 ? -1 : 1),
        type: "tap"
      });
    }
  }

  return expanded;
}

function registerProjectSong(gameMusicListPath: string, project: Op3SongProject, hasJacket: boolean): number {
  const original = readFileSync(gameMusicListPath);
  const existingIndex = findMusicIndex(original, project.id);
  const withoutExisting = existingIndex === null ? original : removeMusicSpec(original, project.id);

  const marker = Buffer.from("</music_list>", "ascii");
  const markerAt = withoutExisting.lastIndexOf(marker);
  if (markerAt < 0) throw new Error("Could not find </music_list>");

  const index = existingIndex !== null && isSmallJacketIndexSafe(existingIndex)
    ? existingIndex
    : findNextMusicIndex(withoutExisting);
  const beforeMarker = withoutExisting.subarray(0, markerAt);
  const needsNewline = beforeMarker.length > 0 && !beforeMarker.subarray(-1).equals(Buffer.from("\n"));
  const prefix = needsNewline ? "\r\n" : "";
  const entry = Buffer.from(`${prefix}${renderProjectMusicSpec(project, index, hasJacket)}\r\n`, "utf8");
  backupOnce(gameMusicListPath);
  writeFileSync(gameMusicListPath, Buffer.concat([
    beforeMarker,
    entry,
    withoutExisting.subarray(markerAt)
  ]));
  return index;
}

function removeMusicSpec(buffer: Buffer, basenameUpper: string): Buffer {
  const text = buffer.toString("latin1");
  const escaped = escapeRegExp(basenameUpper);
  const pattern = new RegExp(`\\s*<music_spec __type='void' index='\\d+'>\\r?\\n(?:(?!\\s*</music_spec>).)*?<basename\\s+__type='str' >${escaped}</basename>(?:(?!\\s*</music_spec>).)*?\\s*</music_spec>\\r?\\n?`, "s");
  const match = text.match(pattern);
  if (!match || match.index === undefined) return buffer;

  const start = Buffer.byteLength(text.slice(0, match.index), "latin1");
  const end = start + Buffer.byteLength(match[0], "latin1");
  return Buffer.concat([buffer.subarray(0, start), buffer.subarray(end)]);
}

function renderProjectMusicSpec(project: Op3SongProject, index: number, hasJacket: boolean): string {
  const normal = project.charts.normal.level;
  const hard = project.charts.hard.level;
  const expert = project.charts.expert.level;
  const real = project.charts.real.level;
  const jacketFlag = hasJacket ? "1" : "0";
  const description = project.description?.trim() || defaultDescription;
  const categoryFlag = Number.isFinite(project.categoryFlag) ? project.categoryFlag : 64;
  const primaryCategory = Number.isFinite(project.primaryCategory) ? project.primaryCategory : 6;
  return [
    `  <music_spec __type='void' index='${index}'>`,
    `    <basename         __type='str' >${escapeXml(project.id)}</basename>`,
    `    <title            __type='str' >${escapeXml(project.title)}</title>`,
    `    <title_kana       __type='str' >${escapeXml(project.title)}</title_kana>`,
    `    <artist           __type='str' >${escapeXml(project.artist)}</artist>`,
    `    <artist_kana      __type='str' >${escapeXml(project.artist)}</artist_kana>`,
    "    <license          __type='str' ></license>",
    "    <license_site     __type='str' ></license_site>",
    "    <priority         __type='s8'  >0</priority>",
    `    <category_flag    __type='s32' >${categoryFlag}</category_flag>`,
    `    <primary_category __type='s8'  >${primaryCategory}</primary_category>`,
    "    <bemani_flag     __type='s32' >0</bemani_flag>",
    "    <bemani_category __type='s8'  >0</bemani_category>",
    "    <add_ver          __type='s32' >3</add_ver>",
    `    <level_normal     __type='s8'  >${normal}</level_normal>`,
    `    <level_hard       __type='s8'  >${hard}</level_hard>`,
    `    <level_extreme    __type='s8'  >${expert}</level_extreme>`,
    `    <level_real       __type='s8'  >${real}</level_real>`,
    "    <recital_support  __type='bool'>1</recital_support>",
    "    <demo_popular     __type='bool'>0</demo_popular>",
    "    <demo_bemani      __type='bool'>0</demo_bemani>",
    "    <destination_j    __type='bool'>1</destination_j>",
    "    <destination_a    __type='bool'>1</destination_a>",
    "    <destination_y    __type='bool'>1</destination_y>",
    "    <destination_k    __type='bool'>1</destination_k>",
    "    <offline          __type='bool'>1</offline>",
    "    <unlock_type      __type='s8'  >1</unlock_type>",
    "    <real_unlock_type __type='s8'  >1</real_unlock_type>",
    "    <volume_bgm       __type='s8'  >0</volume_bgm>",
    "    <volume_key       __type='s8'  >-12</volume_key>",
    `    <jk_jpn          __type='bool'  >${jacketFlag}</jk_jpn>`,
    `    <jk_asia         __type='bool'  >${jacketFlag}</jk_asia>`,
    `    <jk_kor          __type='bool'  >${jacketFlag}</jk_kor>`,
    `    <jk_idn          __type='bool'  >${jacketFlag}</jk_idn>`,
    "    <tag_list_data>",
    "    </tag_list_data>",
    "    <start_date       __type='str' >2017-03-01 10:00</start_date>",
    "    <end_date         __type='str' >9999-12-31 23:59</end_date>",
    "    <expiration_date  __type='str' >9999-12-31 23:59</expiration_date>",
    `    <description      __type='str' >${escapeXml(description)}</description>`,
    "    <real_start_date       __type='str' >2017-03-01 10:00</real_start_date>",
    "    <real_end_date         __type='str' >9999-12-31 23:59</real_end_date>",
    "    <real_once_price       __type='s32' >0</real_once_price>",
    "    <real_forever_price    __type='s32' >0</real_forever_price>",
    "    <force_unlock_date       __type='str' >2017-03-01 10:00</force_unlock_date>",
    "    <real_force_unlock_date  __type='str' >2017-03-01 10:00</real_force_unlock_date>",
    "  </music_spec>",
    ""
  ].join("\r\n");
}

function installProjectPcmAudio(gameDir: string, projectPath: string, project: Op3SongProject, songFolder: string, options: InstallProjectOptions) {
  const projectDir = dirname(projectPath);
  const audioPath = project.audioPath ? resolve(projectDir, project.audioPath) : null;
  if (!audioPath || !existsSync(audioPath)) {
    console.log("Project has no readable audioPath; wrote charts and metadata only.");
    return;
  }

  const targetBase = join(songFolder, project.id.toLowerCase());
  const template = pcmTemplateForProject(project);
  const sourceBase = join(gameDir, "data_op3", "sound", "music", template.basenameLower, template.basenameLower);
  if (!existsSync(`${sourceBase}.xsb`) || !existsSync(`${sourceBase}_pre.xsb`)) {
    throw new Error(`PCM audio template is missing in target game: ${sourceBase}`);
  }

  const mainBankName = options.uniqueXsb ? uniqueXactBankName(project.id, false) : template.basenameUpper;
  const previewBankName = options.uniqueXsb ? uniqueXactBankName(project.id, true) : `${template.basenameUpper}_pre`;

  if (options.uniqueXsb) {
    copyPatchedSoundbank(`${sourceBase}.xsb`, `${targetBase}.xsb`, template.basenameUpper, mainBankName);
    copyPatchedSoundbank(`${sourceBase}_pre.xsb`, `${targetBase}_pre.xsb`, `${template.basenameUpper}_pre`, previewBankName);
  } else {
    copyFileSync(`${sourceBase}.xsb`, `${targetBase}.xsb`);
    copyFileSync(`${sourceBase}_pre.xsb`, `${targetBase}_pre.xsb`);
  }

  buildXwbFromAudio(audioPath, `${targetBase}.xwb`, mainBankName, { preview: false, codec: "pcm" });
  buildXwbFromAudio(audioPath, `${targetBase}_pre.xwb`, previewBankName, { preview: true, codec: "pcm" });
  console.log(`Installed PCM audio using internal template ${template.basenameUpper}${options.uniqueXsb ? ` as ${mainBankName}` : ""}.`);
}

function pcmTemplateForProject(project: Op3SongProject): typeof pcmAudioTemplates[number] {
  const digest = createHash("sha1").update(project.id.toUpperCase()).digest();
  return pcmAudioTemplates[(digest[0] + digest[1]) % pcmAudioTemplates.length];
}

function uniqueXactBankName(projectId: string, preview: boolean): string {
  const stem = `MOC${createHash("sha1").update(projectId.toUpperCase()).digest("hex").slice(0, 8).toUpperCase()}`;
  return preview ? `${stem}_pre` : stem;
}

function installProjectJacket(
  gameDir: string,
  projectPath: string,
  project: Op3SongProject,
  musicIndex: number,
  options: { installSmall: boolean } = { installSmall: true }
) {
  const jacketPath = resolveProjectJacketPath(projectPath, project) ?? "__op3_mapper_placeholder__";

  const padded = String(musicIndex).padStart(4, "0");
  const largeRoot = join(gameDir, "data", "jacket", "jkms_l");
  const smallRoot = join(gameDir, "data", "jacket", "jkms_s");
  const gameJacketTemplatePath = join(largeRoot, "afp_jkms0405_l.ifs");
  mkdirSync(largeRoot, { recursive: true });
  mkdirSync(smallRoot, { recursive: true });

  const largeOutput = join(largeRoot, `afp_jkms${padded}_l.ifs`);
  const largeResult = spawnSync("py", [
    buildJacketScript,
    gameJacketTemplatePath,
    jacketPath,
    largeOutput,
    String(musicIndex),
    project.title
  ], {
    cwd: mapperRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  if (largeResult.status !== 0) {
    throw new Error(`Project jacket build failed:\n${largeResult.stdout}\n${largeResult.stderr}`);
  }

  if (options.installSmall) {
    const smallPack = Math.floor(musicIndex / 10);
    const smallPackPadded = String(smallPack).padStart(3, "0");
    const smallTemplate = join(smallRoot, `afp_jkms${smallPackPadded}_s.ifs`);
    const smallOutput = smallTemplate;
    ensureSmallJacketPack(smallRoot, smallPack, smallTemplate);
    const smallResult = spawnSync("py", [
      buildSmallJacketScript,
      smallTemplate,
      jacketPath,
      smallOutput,
      String(musicIndex),
      project.title,
      project.artist,
      project.description?.trim() || defaultDescription
    ], {
      cwd: mapperRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024
    });
    if (smallResult.status !== 0) {
      throw new Error(`Project small jacket build failed:\n${smallResult.stdout}\n${smallResult.stderr}`);
    }
  }

  const gameFilepathInfoPath = join(gameDir, "prop", "filepath.info");
  registerFilepathInfo(gameFilepathInfoPath, `data/jacket/jkms_l/afp_jkms${padded}_l.ifs`, "data/jacket/jkms_s/afp_jkms000_s.ifs");
  if (options.installSmall) {
    const smallPackPadded = String(Math.floor(musicIndex / 10)).padStart(3, "0");
    registerFilepathInfo(gameFilepathInfoPath, `data/jacket/jkms_s/afp_jkms${smallPackPadded}_s.ifs`, "data/movie/2g01_twin_piano.wmv");
  }
}

function ensureSmallJacketPack(smallRoot: string, smallPack: number, targetPath: string) {
  if (existsSync(targetPath)) return;

  const available = readdirSync(smallRoot)
    .map((name) => {
      const match = name.match(/^afp_jkms(\d{3})_s\.ifs$/i);
      return match ? { name, pack: Number(match[1]) } : null;
    })
    .filter((entry): entry is { name: string; pack: number } => entry !== null)
    .sort((a, b) => Math.abs(a.pack - smallPack) - Math.abs(b.pack - smallPack) || b.pack - a.pack);

  const template = available[0];
  if (!template) {
    throw new Error(`No small jacket packs were found in target game: ${smallRoot}`);
  }

  const templatePath = join(smallRoot, template.name);
  copyFileSync(templatePath, targetPath);
  console.log(`Created missing small jacket pack ${targetPath} from ${template.name}.`);
}

function difficultySuffix(difficulty: Op3Difficulty): string {
  if (difficulty === "normal") return "00normal";
  if (difficulty === "hard") return "01hard";
  if (difficulty === "expert") return "02extreme";
  return "03real";
}

function buildScoreXml(config: SongConfig, difficulty: Difficulty, durationMsec: number, analysis: AudioAnalysis | null): string {
  const beatMsec = 60000 / config.bpm;
  const stepMsec = beatMsec / Math.max(1, Math.min(4, difficulty.density));
  const introMsec = Math.round(beatMsec * 4);
  const finish = Math.max(durationMsec + 1250, introMsec + 30000);
  const usableEnd = finish - Math.round(beatMsec * 2);
  const notes: ChartNote[] = [];
  const activeHolds: ChartNote[] = [];

  let gridStep = 0;
  for (let t = introMsec; t < usableEnd; t += stepMsec) {
    const step = gridStep++;
    if (!shouldPlaceNote(step, difficulty, Math.round(t), analysis)) continue;

    const start = Math.round(t);
    const score = analysis ? audioScoreAt(analysis, start) : 0.5;
    const planned = planNotesForStep(start, step, beatMsec, difficulty, score, usableEnd);

    for (const note of planned) {
      pruneExpiredHolds(activeHolds, note.start);
      if (note.noteType === 0 && overlapsActiveHold(note, activeHolds)) continue;
      if (note.noteType !== 0 && overlapsActiveHold(note, activeHolds)) continue;

      notes.push(note);
      if (note.noteType !== 0) {
        activeHolds.push(note);
      }
    }
  }

  const cleanedNotes = removeTapsUnderHolds(notes);
  const renderedNotes = cleanedNotes
    .sort((a, b) => a.start - b.start || a.hand - b.hand || a.minKey - b.minKey)
    .map((note, index) => renderNote({
      index: index + 1,
      start: note.start,
      end: note.end,
      gate: note.end - note.start,
      scale: note.scale,
      minKey: note.minKey,
      maxKey: note.maxKey,
      noteType: note.noteType,
      hand: note.hand,
      subNotes: note.subNotes
    }));

  return [
    '<?xml version="1.0"?>',
    "<music_score>",
    "  <header>",
    `    <max_scale __type="s32">${84}</max_scale>`,
    `    <min_scale __type="s32">${24}</min_scale>`,
    '    <file_version __type="s16">1</file_version>',
    `    <first_bpm __type="s64">${Math.round(config.bpm * 100000)}</first_bpm>`,
    `    <music_finish_time_msec __type="s32">${finish}</music_finish_time_msec>`,
    "  </header>",
    "  <note_data>",
    renderedNotes.join(""),
    "  </note_data>",
    renderEventData(config, difficulty, introMsec),
    renderBeatData(config, finish),
    renderTrackInfo(),
    renderVelocityZoneData(introMsec, usableEnd),
    "</music_score>",
    ""
  ].join("\r\n");
}

function renderEventData(config: SongConfig, difficulty: Difficulty, introMsec: number): string {
  const events = [
    { index: 0, start: 0, type: 0, value: Math.round(config.bpm * 100000) },
    { index: 1, start: 0, type: 1, value: Math.round(100 + difficulty.level * 3) },
    { index: 2, start: 0, type: 2, value: 11 },
    { index: 3, start: introMsec, type: 3, value: 24 },
    { index: 4, start: introMsec, type: 4, value: 20 },
    { index: 5, start: introMsec, type: 5, value: 24 },
    { index: 6, start: introMsec, type: 6, value: 120 },
    { index: 7, start: introMsec, type: 7, value: 0 },
    { index: 8, start: introMsec, type: 8, value: 80 }
  ];

  return [
    "  <event_data>",
    ...events.map((event) => [
      "    <event>",
      `      <index __type="s32">${event.index}</index>`,
      `      <start_timing_msec __type="s32">${event.start}</start_timing_msec>`,
      `      <type __type="s32">${event.type}</type>`,
      `      <value __type="s64">${event.value}</value>`,
      "    </event>"
    ].join("\r\n")),
    "  </event_data>"
  ].join("\r\n");
}

function renderBeatData(config: SongConfig, finishMsec: number): string {
  const beatMsec = 60000 / config.bpm;
  const beats: string[] = [];
  let index = 0;
  for (let t = 0; t <= finishMsec; t += beatMsec) {
    beats.push([
      "    <beat>",
      `      <index __type="s32">${index}</index>`,
      `      <start_timing_msec __type="s32">${Math.round(t)}</start_timing_msec>`,
      "    </beat>"
    ].join("\r\n"));
    index++;
  }

  return [
    "  <beat_data>",
    beats.join("\r\n"),
    "  </beat_data>"
  ].join("\r\n");
}

function renderTrackInfo(): string {
  return [
    "  <track_info>",
    "    <track>",
    '      <index __type="s32">1</index>',
    '      <name __type="str">key_apiano1</name>',
    "    </track>",
    "    <track>",
    '      <index __type="s32">2</index>',
    '      <name __type="str">key_apiano1</name>',
    "    </track>",
    "    <track>",
    '      <index __type="s32">3</index>',
    '      <name __type="str">key_apiano1</name>',
    "    </track>",
    "  </track_info>"
  ].join("\r\n");
}

function renderVelocityZoneData(startMsec: number, endMsec: number): string {
  return [
    "  <velocity_zone_data>",
    "    <velocity_zone>",
    '      <index __type="s32">0</index>',
    `      <start_timing_msec __type="s32">${startMsec}</start_timing_msec>`,
    `      <end_timing_msec __type="s32">${endMsec}</end_timing_msec>`,
    '      <velocity_type __type="s32">1</velocity_type>',
    "    </velocity_zone>",
    "  </velocity_zone_data>"
  ].join("\r\n");
}

function shouldPlaceNote(step: number, difficulty: Difficulty, startMsec: number, analysis: AudioAnalysis | null): boolean {
  if (!analysis) {
    if (difficulty.density <= 1) return step % 2 === 0 || step % 16 === 7;
    if (difficulty.density === 2) return step % 3 !== 2;
    if (difficulty.density === 3) return step % 4 !== 3 || step % 16 === 11;
    return step % 5 !== 4;
  }

  const score = audioScoreAt(analysis, startMsec);
  const downbeat = step % (difficulty.density * 4) === 0;
  const phraseAccent = step % (difficulty.density * 16) === difficulty.density * 8;

  if (difficulty.density <= 1) return downbeat || score > 0.68;
  if (difficulty.density === 2) return downbeat || phraseAccent || score > 0.52;
  if (difficulty.density === 3) return downbeat || score > 0.42 || (phraseAccent && score > 0.25);
  return downbeat || score > 0.34 || (step % 3 === 0 && score > 0.24);
}

function planNotesForStep(start: number, step: number, beatMsec: number, difficulty: Difficulty, audioScore: number, usableEnd: number): ChartNote[] {
  const phraseStep = step % Math.max(16, difficulty.density * 16);
  const downbeat = phraseStep % Math.max(1, difficulty.density * 4) === 0;
  const width = noteWidthForDifficulty(difficulty);
  const notes: ChartNote[] = [];

  const primaryHand = choosePrimaryHand(step, difficulty);
  const isHold = shouldMakeHold(step, difficulty, audioScore);
  notes.push(makeChartNote({
    start,
    duration: isHold ? Math.round(beatMsec * holdBeatsForDifficulty(difficulty)) : Math.round(Math.max(100, beatMsec * 0.5)),
    hand: primaryHand,
    width,
    keyCenter: keyCenterForHand(primaryHand, step, difficulty),
    noteType: isHold ? 2 : 0,
    step,
    difficulty,
    usableEnd
  }));

  const addTwoHand = downbeat && difficulty.density >= 2 && audioScore > 0.42;
  const addAnswer = difficulty.density >= 3 && phraseStep % (difficulty.density * 4) === difficulty.density * 2 && audioScore > 0.32;
  if (addTwoHand || addAnswer) {
    const otherHand = primaryHand === 1 ? 0 : 1;
    notes.push(makeChartNote({
      start,
      duration: Math.round(Math.max(95, beatMsec * (addTwoHand ? 0.55 : 0.38))),
      hand: otherHand,
      width,
      keyCenter: keyCenterForHand(otherHand, step + 3, difficulty),
      noteType: 0,
      step: step + 3,
      difficulty,
      usableEnd
    }));
  }

  return notes;
}

function makeChartNote(input: {
  start: number;
  duration: number;
  hand: number;
  width: number;
  keyCenter: number;
  noteType: number;
  step: number;
  difficulty: Difficulty;
  usableEnd: number;
}): ChartNote {
  const end = Math.min(input.start + input.duration, input.usableEnd);
  const halfLeft = Math.floor((input.width - 1) / 2);
  const halfRight = input.width - 1 - halfLeft;
  const minKey = clamp(input.keyCenter - halfLeft, 0, 27);
  const maxKey = clamp(input.keyCenter + halfRight, 0, 27);
  const scale = scaleForHand(input.hand, input.step, input.difficulty);
  return {
    start: input.start,
    end,
    scale,
    minKey,
    maxKey,
    noteType: input.noteType,
    hand: input.hand,
    subNotes: buildSubNotes(input.start, end, scale, input.hand, input.step, input.difficulty)
  };
}

function choosePrimaryHand(step: number, difficulty: Difficulty): number {
  const phrase = Math.floor(step / Math.max(1, difficulty.density * 8));
  if (difficulty.density <= 1) {
    return (phrase + Math.floor(step / 4)) % 2 === 0 ? 1 : 0;
  }

  const pattern = difficulty.density >= 3
    ? [1, 0, 0, 1, 0, 1, 1, 0]
    : [1, 0, 1, 0, 0, 1];
  return pattern[(step + phrase) % pattern.length];
}

function keyCenterForHand(hand: number, step: number, difficulty: Difficulty): number {
  const left = difficulty.density >= 3 ? [7, 9, 11, 8, 12, 10] : [8, 11, 9, 12];
  const right = difficulty.density >= 3 ? [16, 18, 20, 22, 17, 21] : [17, 20, 18, 22];
  const both = [13, 14, 15];
  const phrase = Math.floor(step / Math.max(1, difficulty.density * 4));
  const palette = hand === 1 ? left : hand === 0 ? right : both;
  return palette[Math.abs(step + phrase * 2) % palette.length];
}

function scaleForHand(hand: number, step: number, difficulty: Difficulty): number {
  const left = [36, 38, 40, 43, 45, 48];
  const right = difficulty.density >= 3 ? [60, 62, 63, 67, 69, 72] : [60, 62, 64, 67, 69, 72];
  const mid = [50, 52, 55, 57];
  const palette = hand === 1 ? left : hand === 0 ? right : mid;
  const phrase = Math.floor(step / 16);
  return palette[Math.abs(step * 2 + phrase * 3) % palette.length];
}

function noteWidthForDifficulty(difficulty: Difficulty): number {
  if (difficulty.density <= 1) return 5;
  if (difficulty.density === 2) return 4;
  return 3;
}

function holdBeatsForDifficulty(difficulty: Difficulty): number {
  if (difficulty.density <= 1) return 1.75;
  if (difficulty.density === 2) return 1.25;
  return 0.9;
}

function shouldMakeHold(step: number, difficulty: Difficulty, audioScore: number): boolean {
  if (step <= 0) return false;
  if (difficulty.density <= 1) return step % 24 === 0 && audioScore > 0.25;
  if (difficulty.density === 2) return step % difficulty.holdEvery === 0 && audioScore > 0.35;
  return step % difficulty.holdEvery === 0 && audioScore > 0.48;
}

function pruneExpiredHolds(activeHolds: ChartNote[], start: number) {
  for (let i = activeHolds.length - 1; i >= 0; i--) {
    if (activeHolds[i].end <= start) {
      activeHolds.splice(i, 1);
    }
  }
}

function overlapsActiveHold(note: ChartNote, activeHolds: ChartNote[]): boolean {
  return activeHolds.some((hold) => (
    note.start < hold.end &&
    note.end > hold.start &&
    note.minKey <= hold.maxKey &&
    note.maxKey >= hold.minKey
  ));
}

function removeTapsUnderHolds(notes: ChartNote[]): ChartNote[] {
  const holds = notes.filter((note) => note.noteType !== 0);
  return notes.filter((note) => note.noteType !== 0 || !overlapsActiveHold(note, holds));
}

function buildSubNotes(start: number, end: number, scale: number, hand: number, step: number, difficulty: Difficulty): SubNote[] {
  const track = hand === 1 ? 2 : 1;
  const subNotes: SubNote[] = [{ start, end, scale, velocity: 112, track }];

  if (difficulty.density >= 2 && step % difficulty.octaveEvery === 0) {
    subNotes.push({
      start,
      end,
      scale: clamp(scale - 12, 12, 84),
      velocity: 90,
      track
    });
  }

  return subNotes;
}

type SubNote = {
  start: number;
  end: number;
  scale: number;
  velocity: number;
  track: number;
};

function renderNote(note: {
  index: number;
  start: number;
  end: number;
  gate: number;
  scale: number;
  minKey: number;
  maxKey: number;
  noteType: number;
  hand: number;
  subNotes: SubNote[];
}): string {
  const sub = note.subNotes.map((s) => [
    "        <sub_note>",
    `          <start_timing_msec __type="s32">${s.start}</start_timing_msec>`,
    `          <end_timing_msec __type="s32">${s.end}</end_timing_msec>`,
    `          <scale_piano __type="u8">${s.scale}</scale_piano>`,
    `          <velocity __type="u8">${s.velocity}</velocity>`,
    `          <track_index __type="s32">${s.track}</track_index>`,
    "        </sub_note>"
  ].join("\r\n")).join("\r\n");

  return [
    "    <note>",
    `      <index __type="s32">${note.index}</index>`,
    `      <start_timing_msec __type="s32">${note.start}</start_timing_msec>`,
    `      <end_timing_msec __type="s32">${note.end}</end_timing_msec>`,
    `      <gate_time_msec __type="s32">${note.gate}</gate_time_msec>`,
    `      <scale_piano __type="u8">${note.scale}</scale_piano>`,
    `      <min_key_index __type="s32">${note.minKey}</min_key_index>`,
    `      <max_key_index __type="s32">${note.maxKey}</max_key_index>`,
    `      <note_type __type="s32">${note.noteType}</note_type>`,
    `      <hand __type="s32">${note.hand}</hand>`,
    '      <key_kind __type="s32">0</key_kind>',
    '      <param1 __type="s32">0</param1>',
    '      <param2 __type="s32">0</param2>',
    '      <param3 __type="s32">0</param3>',
    "      <sub_note_data>",
    sub,
    "      </sub_note_data>",
    "    </note>",
    ""
  ].join("\r\n");
}

function registerSong(config: SongConfig): number {
  const original = readFileSync(musicListPath);
  const marker = Buffer.from("</music_list>", "ascii");

  const existingIndex = findMusicIndex(original, config.basenameUpper);
  if (existingIndex !== null) {
    console.log(`${config.basenameUpper} is already registered`);
    return existingIndex;
  }

  const index = findNextMusicIndex(original);
  const entry = Buffer.from(renderMusicSpec(config, index), "ascii");
  const markerAt = original.lastIndexOf(marker);
  if (markerAt < 0) throw new Error("Could not find </music_list>");

  backupOnce(musicListPath);
  const patched = Buffer.concat([
    original.subarray(0, markerAt),
    entry,
    original.subarray(markerAt)
  ]);
  writeFileSync(musicListPath, patched);
  return index;
}

function unregisterSong(basenameUpper: string) {
  const original = readFileSync(musicListPath);
  const text = original.toString("latin1");
  const escaped = escapeRegExp(basenameUpper);
  const pattern = new RegExp(`  <music_spec __type='void' index='\\d+'>\\r?\\n(?:(?!  </music_spec>).)*?<basename\\s+__type='str' >${escaped}</basename>(?:(?!  </music_spec>).)*?  </music_spec>\\r?\\n`, "s");
  const match = text.match(pattern);

  if (!match || match.index === undefined) {
    console.log(`${basenameUpper} is not registered`);
    return;
  }

  backupOnce(musicListPath);
  const start = Buffer.byteLength(text.slice(0, match.index), "latin1");
  const end = start + Buffer.byteLength(match[0], "latin1");
  writeFileSync(musicListPath, Buffer.concat([original.subarray(0, start), original.subarray(end)]));
}

function renderMusicSpec(config: SongConfig, index: number): string {
  const [normal, hard, extreme, real] = config.levels;
  return [
    `  <music_spec __type='void' index='${index}'>`,
    `    <basename         __type='str' >${config.basenameUpper}</basename>`,
    `    <title            __type='str' >${escapeXml(config.title)}</title>`,
    `    <title_kana       __type='str' >${escapeXml(config.titleKana)}</title_kana>`,
    `    <artist           __type='str' >${escapeXml(config.artist)}</artist>`,
    `    <artist_kana      __type='str' >${escapeXml(config.artistKana)}</artist_kana>`,
    "    <license          __type='str' ></license>",
    "    <license_site     __type='str' ></license_site>",
    "    <priority         __type='s8'  >0</priority>",
    "    <category_flag    __type='s32' >128</category_flag>",
    "    <primary_category __type='s8'  >6</primary_category>",
    "    <bemani_flag     __type='s32' >0</bemani_flag>",
    "    <bemani_category __type='s8'  >0</bemani_category>",
    "    <add_ver          __type='s32' >3</add_ver>",
    `    <level_normal     __type='s8'  >${normal}</level_normal>`,
    `    <level_hard       __type='s8'  >${hard}</level_hard>`,
    `    <level_extreme    __type='s8'  >${extreme}</level_extreme>`,
    `    <level_real       __type='s8'  >${real}</level_real>`,
    "    <recital_support  __type='bool'>1</recital_support>",
    "    <demo_popular     __type='bool'>0</demo_popular>",
    "    <demo_bemani      __type='bool'>0</demo_bemani>",
    "    <destination_j    __type='bool'>1</destination_j>",
    "    <destination_a    __type='bool'>1</destination_a>",
    "    <destination_y    __type='bool'>1</destination_y>",
    "    <destination_k    __type='bool'>1</destination_k>",
    "    <offline          __type='bool'>1</offline>",
    "    <unlock_type      __type='s8'  >1</unlock_type>",
    "    <real_unlock_type __type='s8'  >1</real_unlock_type>",
    "    <volume_bgm       __type='s8'  >0</volume_bgm>",
    "    <volume_key       __type='s8'  >0</volume_key>",
    "    <jk_jpn          __type='bool'  >1</jk_jpn>",
    "    <jk_asia         __type='bool'  >1</jk_asia>",
    "    <jk_kor          __type='bool'  >1</jk_kor>",
    "    <jk_idn          __type='bool'  >1</jk_idn>",
    "    <tag_list_data>",
    "    </tag_list_data>",
    "    <start_date       __type='str' >2017-03-01 10:00</start_date>",
    "    <end_date         __type='str' >9999-12-31 23:59</end_date>",
    "    <expiration_date  __type='str' >9999-12-31 23:59</expiration_date>",
    `    <description      __type='str' >${escapeXml(config.description)}</description>`,
    "    <real_start_date       __type='str' >2017-03-01 10:00</real_start_date>",
    "    <real_end_date         __type='str' >9999-12-31 23:59</real_end_date>",
    "    <real_once_price       __type='s32' >0</real_once_price>",
    "    <real_forever_price    __type='s32' >0</real_forever_price>",
    "    <force_unlock_date       __type='str' >9999-12-31 23:59</force_unlock_date>",
    "    <real_force_unlock_date  __type='str' >9999-12-31 23:59</real_force_unlock_date>",
    "  </music_spec>",
    ""
  ].join("\r\n");
}

function findNextMusicIndex(buffer: Buffer): number {
  const text = buffer.toString("latin1");
  const used = new Set<number>();
  let max = 0;
  for (const match of text.matchAll(/<music_spec __type='void' index='(\d+)'>/g)) {
    const index = Number(match[1]);
    used.add(index);
    max = Math.max(max, index);
  }

  for (let index = 529; index >= 400; index--) {
    if (!used.has(index) && isSmallJacketIndexSafe(index)) return index;
  }

  return max + 1;
}

function isSmallJacketIndexSafe(index: number): boolean {
  // OP3's select-list small jacket loader appears to use the stock jkms_s pack
  // range. New packs can work for detail art, but list cards render black.
  // 526 is present as a metadata hole in this dump, but its list-cover slot
  // falls back to the blank book placeholder even when the small atlas is valid.
  return index <= 529 && index !== 526;
}

function findMusicIndex(buffer: Buffer, basenameUpper: string): number | null {
  const text = buffer.toString("latin1");
  const escaped = escapeRegExp(basenameUpper);
  const pattern = new RegExp(`<music_spec __type='void' index='(\\d+)'>\\r?\\n(?:(?!  </music_spec>).)*?<basename\\s+__type='str' >${escaped}</basename>`, "s");
  const match = text.match(pattern);
  return match ? Number(match[1]) : null;
}

function installJacket(config: SongConfig, musicIndex: number) {
  if (!existsSync(config.imagePath)) {
    console.log(`Jacket image was not found, skipping: ${config.imagePath}`);
    return;
  }

  const padded = String(musicIndex).padStart(4, "0");
  const outputPath = join(repoRoot, "data", "jacket", "jkms_l", `afp_jkms${padded}_l.ifs`);
  const result = spawnSync("py", [
    buildJacketScript,
    jacketTemplatePath,
    config.imagePath,
    outputPath,
    String(musicIndex)
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });

  if (result.status !== 0) {
    throw new Error(`Jacket build failed:\n${result.stdout}\n${result.stderr}`);
  }

  registerFilepathInfo(filepathInfoPath, `data/jacket/jkms_l/afp_jkms${padded}_l.ifs`, "data/jacket/jkms_s/afp_jkms000_s.ifs");
  installSmallJacket(config, musicIndex);
}

function removeJacket(musicIndex: number) {
  const padded = String(musicIndex).padStart(4, "0");
  const relativePath = `data/jacket/jkms_l/afp_jkms${padded}_l.ifs`;
  const outputPath = join(repoRoot, relativePath.replace(/\//g, "\\"));
  if (existsSync(outputPath)) {
    rmSync(outputPath, { force: true });
  }
  unregisterFilepathInfo(relativePath);
  restoreSmallJacketPack();
}

function installSmallJacket(config: SongConfig, musicIndex: number) {
  const result = spawnSync("py", [
    buildSmallJacketScript,
    smallJacketPackPath,
    config.imagePath,
    smallJacketPackPath,
    String(musicIndex)
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });

  if (result.status !== 0) {
    throw new Error(`Small jacket build failed:\n${result.stdout}\n${result.stderr}`);
  }
}

function restoreSmallJacketPack() {
  const backup = `${smallJacketPackPath}.op3-mapper.bak`;
  if (existsSync(backup)) {
    copyFileSync(backup, smallJacketPackPath);
  }
}

function installPlaceholderAudio(config: SongConfig, folder: string) {
  const targetBase = join(folder, config.basenameLower);
  const sourceBase = join(musicRoot, audioTemplate.basenameLower, audioTemplate.basenameLower);

  copyPatchedSoundbank(
    `${sourceBase}.xsb`,
    `${targetBase}.xsb`,
    audioTemplate.basenameUpper,
    config.basenameUpper
  );
  copyPatchedWavebank(`${sourceBase}.xwb`, `${targetBase}.xwb`, config.basenameUpper);

  copyPatchedSoundbank(
    `${sourceBase}_pre.xsb`,
    `${targetBase}_pre.xsb`,
    `${audioTemplate.basenameUpper}_pre`,
    `${config.basenameUpper}_pre`
  );
  copyPatchedWavebank(`${sourceBase}_pre.xwb`, `${targetBase}_pre.xwb`, `${config.basenameUpper}_pre`);
}

function copyPatchedSoundbank(sourcePath: string, targetPath: string, sourceName: string, targetName: string) {
  const patched = patchFixedXsbName(readFileSync(sourcePath), sourceName, targetName);
  writeFileSync(targetPath, patched);
}

function copyPatchedWavebank(sourcePath: string, targetPath: string, bankName: string) {
  const patched = patchXwbBankName(readFileSync(sourcePath), bankName);
  writeFileSync(targetPath, patched);
}

function patchFixedXsbName(source: Buffer, sourceName: string, targetName: string): Buffer {
  const sourceBytes = Buffer.from(sourceName, "ascii");
  const targetBytes = Buffer.from(targetName, "ascii");
  if (targetBytes.length > sourceBytes.length) {
    throw new Error(`Target XSB name is too long: ${targetName} > ${sourceName}`);
  }

  const patched = Buffer.from(source);
  let replacements = 0;
  let offset = 0;
  while ((offset = patched.indexOf(sourceBytes, offset)) >= 0) {
    patched.fill(0, offset, offset + sourceBytes.length);
    targetBytes.copy(patched, offset);
    replacements++;
    offset += sourceBytes.length;
  }

  if (replacements < 2) {
    throw new Error(`Expected to patch at least two XSB name fields in ${sourceName}, patched ${replacements}`);
  }

  updateXsbChecksum(patched);
  return patched;
}

function updateXsbChecksum(xsb: Buffer) {
  if (xsb.subarray(0, 4).toString("ascii") !== "SDBK") {
    throw new Error("Not an XSB/SDBK file");
  }
  if (xsb.length < 18) {
    throw new Error("XSB is shorter than expected");
  }
  xsb.writeUInt16LE(xactFcs16(xsb.subarray(18)), 8);
}

function xactFcs16(data: Buffer): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
    }
  }
  return (~crc) & 0xffff;
}

function buildXwbFromAudio(audioPath: string, outputPath: string, bankName: string, options: { preview: boolean; codec?: "adpcm" | "pcm" }) {
  const require = createRequire(import.meta.url);
  const ffmpeg = require("@ffmpeg-installer/ffmpeg") as { path: string };
  const xwbTool = resolveXwbTool();
  const codec = options.codec ?? "adpcm";
  const safeName = bankName.toLowerCase();
  const scratchId = createHash("sha1").update(resolve(outputPath)).digest("hex").slice(0, 10);
  const wavPath = join(scratchRoot, `${safeName}.${scratchId}.${codec}.wav`);
  const tempXwbPath = join(scratchRoot, `${safeName}.${scratchId}.xwb`);

  const ffmpegArgs = [
    "-y",
    "-hide_banner",
    "-loglevel", "error"
  ];

  if (options.preview) {
    ffmpegArgs.push("-ss", "30", "-t", "18");
  }

  ffmpegArgs.push(
    "-i", audioPath,
    "-ac", "2",
    "-ar", "44100",
    "-c:a", codec === "pcm" ? "pcm_s16le" : "adpcm_ms",
    wavPath
  );

  const ffmpegResult = spawnSync(ffmpeg.path, ffmpegArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  if (ffmpegResult.status !== 0) {
    throw new Error(`FFmpeg ADPCM conversion failed:\n${ffmpegResult.stdout}\n${ffmpegResult.stderr}`);
  }

  const xwbResult = spawnSync(xwbTool, [
    "-y",
    "-nc",
    "-o", tempXwbPath,
    wavPath
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  if (xwbResult.status !== 0) {
    throw new Error(`XWBTool build failed:\n${xwbResult.stdout}\n${xwbResult.stderr}`);
  }

  const patched = patchXwbBankName(readFileSync(tempXwbPath), bankName);
  writeFileSync(outputPath, patched);
}

function patchXwbBankName(source: Buffer, bankName: string): Buffer {
  const patched = Buffer.from(source);
  if (patched.subarray(0, 4).toString("ascii") !== "WBND") {
    throw new Error("Not an XWB/WBND file");
  }

  const bankSegmentOffset = patched.readUInt32LE(12);
  const bankSegmentLength = patched.readUInt32LE(16);
  if (bankSegmentLength < 96) {
    throw new Error("XWB bank data segment is shorter than expected");
  }

  const nameBytes = Buffer.from(bankName, "ascii");
  if (nameBytes.length >= 64) {
    throw new Error(`XWB bank name is too long: ${bankName}`);
  }

  const nameOffset = bankSegmentOffset + 8;
  patched.writeUInt32LE(0x80000, bankSegmentOffset);
  patched.writeUInt32LE(64, bankSegmentOffset + 76);
  patched.fill(0, nameOffset, nameOffset + 64);
  nameBytes.copy(patched, nameOffset);
  return patched;
}

function resolveXwbTool(): string {
  const wingetPackagePath = join(
    process.env.LOCALAPPDATA ?? "",
    "Microsoft",
    "WinGet",
    "Packages",
    "Microsoft.DirectX.ToolKit.XWBTool_Microsoft.Winget.Source_8wekyb3d8bbwe",
    "xwbtool.exe"
  );

  if (existsSync(wingetPackagePath)) {
    return wingetPackagePath;
  }

  return "xwbtool";
}

function registerFilepathInfo(filepathInfoFile: string, relativePath: string, insertBefore: string) {
  const filepathInfoPath = filepathInfoFile;
  const original = readFileSync(filepathInfoPath, "latin1");

  const lines = original.replace(/\r?\n/g, "\n").split("\n");
  const existingIndex = lines.indexOf(relativePath);
  const markerLine = insertBefore;
  const markerLineIndex = lines.indexOf(markerLine);
  if (existingIndex >= 0 && (markerLineIndex < 0 || existingIndex < markerLineIndex)) {
    return;
  }

  backupOnce(filepathInfoPath);
  const normalized = lines.filter((line) => line !== relativePath).join("\n");
  const marker = `${insertBefore}\n`;
  const index = normalized.indexOf(marker);
  const patched = index >= 0
    ? normalized.slice(0, index) + `${relativePath}\n` + normalized.slice(index)
    : normalized.replace(/\n?$/, `\n${relativePath}\n`);
  writeFileSync(filepathInfoPath, patched.replace(/\n/g, "\r\n"), "latin1");
}

function unregisterFilepathInfo(relativePath: string) {
  if (!existsSync(filepathInfoPath)) return;
  const original = readFileSync(filepathInfoPath, "latin1");
  const lines = original.replace(/\r?\n/g, "\n").split("\n");
  const filtered = lines.filter((line) => line !== relativePath);
  if (filtered.length === lines.length) return;
  backupOnce(filepathInfoPath);
  writeFileSync(filepathInfoPath, filtered.join("\r\n"), "latin1");
}

function backupOnce(path: string) {
  const backup = `${path}.op3-mapper.bak`;
  if (!existsSync(backup)) {
    copyFileSync(path, backup);
  }
}

function analyzeAudio(path: string): AudioAnalysis | null {
  const require = createRequire(import.meta.url);
  const ffmpeg = require("@ffmpeg-installer/ffmpeg") as { path: string };
  const sampleRate = 11025;
  const frameSize = 512;
  const result = spawnSync(ffmpeg.path, [
    "-v", "error",
    "-i", path,
    "-ac", "1",
    "-ar", String(sampleRate),
    "-f", "s16le",
    "pipe:1"
  ], {
    encoding: "buffer",
    maxBuffer: 128 * 1024 * 1024
  });

  if (result.status !== 0 || !result.stdout?.length) {
    return null;
  }

  const pcm = result.stdout;
  const sampleCount = Math.floor(pcm.length / 2);
  const frameCount = Math.floor(sampleCount / frameSize);
  const rawEnergy: number[] = [];
  const pitchMidi: Array<number | null> = [];
  const pitchConfidence: number[] = [];

  for (let frame = 0; frame < frameCount; frame++) {
    let sum = 0;
    const sampleStart = frame * frameSize;
    for (let i = 0; i < frameSize; i++) {
      const sample = pcm.readInt16LE((sampleStart + i) * 2) / 32768;
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / frameSize);
    rawEnergy.push(rms);
    const pitch = frame % 4 === 0
      ? estimatePcmPitch(pcm, sampleStart, sampleRate, rms)
      : { pitchMidi: null, pitchConfidence: 0 };
    pitchMidi.push(pitch.pitchMidi);
    pitchConfidence.push(pitch.pitchConfidence);
  }

  const energy = normalize(rawEnergy);
  const novelty = normalize(energy.map((value, index) => {
    const previous = index > 0 ? energy[index - 1] : value;
    return Math.max(0, value - previous);
  }));

  return {
    durationMsec: Math.round(sampleCount / sampleRate * 1000),
    frameMsec: frameSize / sampleRate * 1000,
    energy,
    novelty,
    pitchMidi,
    pitchConfidence
  };
}

function estimatePcmPitch(
  pcm: Buffer,
  sampleStart: number,
  sampleRate: number,
  rms: number
): { pitchMidi: number | null; pitchConfidence: number } {
  if (rms < 0.006) return { pitchMidi: null, pitchConfidence: 0 };

  const windowSize = 1536;
  const minLag = Math.floor(sampleRate / 900);
  const maxLag = Math.floor(sampleRate / 80);
  const sampleStep = 4;
  let bestLag = 0;
  let bestDifference = Number.POSITIVE_INFINITY;
  let baselineDifference = 0;
  let tested = 0;

  for (let lag = minLag; lag <= maxLag; lag += 2) {
    let difference = 0;
    let count = 0;
    for (let i = 0; i + lag < windowSize; i += sampleStep) {
      const sample = readPcmSample(pcm, sampleStart + i);
      const delayed = readPcmSample(pcm, sampleStart + i + lag);
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

function readPcmSample(pcm: Buffer, sampleIndex: number): number {
  const byteIndex = sampleIndex * 2;
  if (byteIndex < 0 || byteIndex + 1 >= pcm.length) return 0;
  return pcm.readInt16LE(byteIndex) / 32768;
}

function audioScoreAt(analysis: AudioAnalysis, msec: number): number {
  const index = clamp(Math.round(msec / analysis.frameMsec), 0, analysis.energy.length - 1);
  const localNovelty = maxAround(analysis.novelty, index, 2);
  const localEnergy = maxAround(analysis.energy, index, 1);
  return clamp(localNovelty * 0.72 + localEnergy * 0.28, 0, 1);
}

function maxAround(values: number[], center: number, radius: number): number {
  let best = 0;
  for (let i = Math.max(0, center - radius); i <= Math.min(values.length - 1, center + radius); i++) {
    best = Math.max(best, values[i]);
  }
  return best;
}

function normalize(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  const ceiling = sorted[Math.floor(sorted.length * 0.98)] ?? 1;
  const span = Math.max(ceiling - floor, 0.000001);
  return values.map((value) => clamp((value - floor) / span, 0, 1));
}

function readMp3DurationMsec(path: string): number | null {
  const data = readFileSync(path);
  let offset = 0;
  let duration = 0;
  let frames = 0;

  if (data.subarray(0, 3).toString("ascii") === "ID3" && data.length >= 10) {
    offset = 10 + ((data[6] & 0x7f) << 21) + ((data[7] & 0x7f) << 14) + ((data[8] & 0x7f) << 7) + (data[9] & 0x7f);
  }

  while (offset + 4 < data.length) {
    if (data[offset] !== 0xff || (data[offset + 1] & 0xe0) !== 0xe0) {
      offset++;
      continue;
    }

    const versionBits = (data[offset + 1] >> 3) & 0x03;
    const layerBits = (data[offset + 1] >> 1) & 0x03;
    const bitrateIndex = (data[offset + 2] >> 4) & 0x0f;
    const sampleRateIndex = (data[offset + 2] >> 2) & 0x03;
    const padding = (data[offset + 2] >> 1) & 0x01;

    if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
      offset++;
      continue;
    }

    const mpeg1 = versionBits === 3;
    const sampleRates = mpeg1 ? [44100, 48000, 32000] : versionBits === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000];
    const bitrates = mpeg1
      ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const sampleRate = sampleRates[sampleRateIndex];
    const bitrate = bitrates[bitrateIndex] * 1000;
    const samplesPerFrame = mpeg1 ? 1152 : 576;
    const frameLength = Math.floor((mpeg1 ? 144 : 72) * bitrate / sampleRate + padding);

    if (frameLength <= 4) {
      offset++;
      continue;
    }

    duration += samplesPerFrame / sampleRate;
    frames++;
    offset += frameLength;
  }

  return frames > 10 ? Math.round(duration * 1000) : null;
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

main();
