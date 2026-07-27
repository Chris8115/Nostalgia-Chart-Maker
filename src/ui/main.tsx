import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Copy, Download, Eraser, FileAudio, FlipHorizontal2, FolderOpen, Grip, HelpCircle, Magnet, MousePointer2, Music2, Pause, Play, Plus, RefreshCw, Repeat2, Save, Trash2, X } from "lucide-react";
import JSZip from "jszip";
import {
  Op3Difficulty,
  Op3Hand,
  Op3Note,
  Op3SongProject,
  createEmptyProject,
  categoryOptions,
  defaultDescription,
  difficulties,
  keyWidth,
  validateProject
} from "../shared/project";
import { analyzeAudioGuideFromAudio, estimateBpmFromAudio, generateProjectFromAudio, renderProjectPitchesFromAudio, type AudioGuidePoint, type BpmEstimate } from "./audioMapper";
import "./styles.css";

type Tool = "select" | "tap" | "hold" | "trill" | "erase";

type NoteDrag = {
  mode: "move" | "resize";
  notes: Op3Note[];
  startClientX: number;
  startClientY: number;
};

type BoxSelection = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

type MidiGuideNote = {
  startMs: number;
  endMs: number;
  pitch: number;
  velocity: number;
};

type GameSong = {
  index: number;
  basename: string;
  title: string;
  artist: string;
  levels: [number, number, number, number];
  installed: boolean;
  custom: boolean;
};

const laneCount = 28;
const laneWidth = 28;
const timelineHeight = laneCount * laneWidth;
const apiBase = "http://127.0.0.1:5174";
const lowKeysOnTopStorageKey = "nostalgia-chart-maker.lowKeysOnTop";

function App() {
  const [project, setProject] = useState<Op3SongProject>(() => seedProject());
  const [difficulty, setDifficulty] = useState<Op3Difficulty>("normal");
  const [tool, setTool] = useState<Tool>("tap");
  const [snap, setSnap] = useState(4);
  const [zoom, setZoom] = useState(1);
  const [showBeatGuide, setShowBeatGuide] = useState(true);
  const [showAudioGuide, setShowAudioGuide] = useState(false);
  const [showAudioWaveform, setShowAudioWaveform] = useState(true);
  const [showAudioOnsets, setShowAudioOnsets] = useState(false);
  const [showAudioBrightness, setShowAudioBrightness] = useState(false);
  const [audioGuide, setAudioGuide] = useState<AudioGuidePoint[]>([]);
  const [midiGuide, setMidiGuide] = useState<MidiGuideNote[]>([]);
  const [shiftNotesWithOffset, setShiftNotesWithOffset] = useState(true);
  const [showMidiGuide, setShowMidiGuide] = useState(true);
  const [lowKeysOnTop, setLowKeysOnTop] = useState(() => localStorage.getItem(lowKeysOnTopStorageKey) === "true");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [midiFile, setMidiFile] = useState<File | null>(null);
  const [jacketFile, setJacketFile] = useState<File | null>(null);
  const [jacketUrl, setJacketUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackMs, setPlaybackMs] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateDensity, setGenerateDensity] = useState(0.55);
  const [generateSensitivity, setGenerateSensitivity] = useState(0.72);
  const [generateTrills, setGenerateTrills] = useState(true);
  const [generationStatus, setGenerationStatus] = useState<string | null>(null);
  const [bpmAlternatives, setBpmAlternatives] = useState<BpmEstimate["alternatives"]>([]);
  const [gameDir, setGameDir] = useState("");
  const [serverDir, setServerDir] = useState("");
  const [syncServer, setSyncServer] = useState(true);
  const [uniqueXsb, setUniqueXsb] = useState(false);
  const [projectPath, setProjectPath] = useState(".\\m_custom0001_newsong.op3song.json");
  const [songs, setSongs] = useState<GameSong[]>([]);
  const [patcherStatus, setPatcherStatus] = useState<string | null>(null);
  const [patcherBusy, setPatcherBusy] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [boxSelection, setBoxSelection] = useState<BoxSelection | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const noteDragRef = useRef<NoteDrag | null>(null);

  const chart = project.charts[difficulty];
  const issues = useMemo(() => validateProject(project), [project]);
  const beatMs = 60000 / Math.max(1, project.bpm);
  const pxPerMs = 0.06 * zoom;
  const totalWidth = Math.max(1800, project.durationMs * pxPerMs);

  function updateProject(patch: Partial<Op3SongProject>) {
    setProject((current) => ({ ...current, ...patch }));
  }

  function updateCategory(value: string) {
    const option = categoryOptions.find((candidate) => String(candidate.categoryFlag) === value) ?? categoryOptions[categoryOptions.length - 1];
    updateProject({ categoryFlag: option.categoryFlag, primaryCategory: option.primaryCategory });
  }

  function setProjectOffset(nextOffset: number) {
    const roundedOffset = Math.round(nextOffset);
    setProject((current) => {
      const delta = roundedOffset - current.offsetMs;
      const shifted = shiftNotesWithOffset && delta !== 0 ? shiftProjectNotes(current, delta) : current;
      return { ...shifted, offsetMs: roundedOffset };
    });
    setGenerationStatus(`Offset ${roundedOffset}ms${shiftNotesWithOffset ? " (shifted notes)" : ""}`);
  }

  function nudgeOffset(deltaMs: number) {
    setProjectOffset(project.offsetMs + deltaMs);
  }

  function alignOffsetToPlayhead() {
    const audio = audioRef.current;
    const sourceMs = audio ? Math.round(audio.currentTime * 1000) : playbackMs;
    const nextOffset = Math.round(positiveModulo(sourceMs, beatMs));
    setProjectOffset(nextOffset);
    setGenerationStatus(`Aligned beat grid to ${sourceMs}ms. Offset ${nextOffset}ms${shiftNotesWithOffset ? " (shifted notes)" : ""}.`);
  }

  function setOffsetToPlayhead() {
    const audio = audioRef.current;
    const sourceMs = audio ? Math.round(audio.currentTime * 1000) : playbackMs;
    setProjectOffset(sourceMs);
    setGenerationStatus(`Set first beat offset to ${sourceMs}ms${shiftNotesWithOffset ? " (shifted notes)" : ""}.`);
  }

  function seekToMs(nextMs: number) {
    const clamped = clamp(Math.round(nextMs), 0, project.durationMs);
    if (audioRef.current) {
      audioRef.current.currentTime = clamped / 1000;
    }
    setPlaybackMs(clamped);
    if (timelineRef.current) {
      const viewport = timelineRef.current.clientWidth;
      const nextScroll = Math.max(0, clamped * pxPerMs - viewport * 0.45);
      timelineRef.current.scrollLeft = nextScroll;
    }
  }

  function applyBpmAlternative(alternative: BpmEstimate["alternatives"][number]) {
    setProject((current) => ({
      ...current,
      bpm: alternative.bpm,
      offsetMs: alternative.offsetMs
    }));
    setGenerationStatus(`Applied BPM ${alternative.bpm}, offset ${alternative.offsetMs}ms.`);
  }

  function updateChart(notes: Op3Note[]) {
    setProject((current) => ({
      ...current,
      charts: {
        ...current.charts,
        [difficulty]: {
          ...current.charts[difficulty],
          notes: notes.sort((a, b) => a.startMs - b.startMs || a.minKey - b.minKey)
        }
      }
    }));
  }

  function updateNote(noteId: string, patch: Partial<Op3Note>) {
    updateChart(chart.notes.map((note) => note.id === noteId ? { ...note, ...patch } : note));
  }

  function selectedNotes() {
    const selected = new Set(selectedIds);
    return chart.notes.filter((note) => selected.has(note.id));
  }

  function replaceSelection(nextIds: string[]) {
    setSelectedIds([...new Set(nextIds)]);
  }

  function toggleNoteSelection(noteId: string) {
    setSelectedIds((current) => current.includes(noteId) ? current.filter((id) => id !== noteId) : [...current, noteId]);
  }

  function snapTimeMs(timeMs: number) {
    const snapMs = beatMs / snap;
    return Math.max(0, Math.round((timeMs - project.offsetMs) / snapMs) * snapMs + project.offsetMs);
  }

  function addNoteFromPointer(event: React.MouseEvent<HTMLDivElement>) {
    if (!timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const localX = event.clientX - rect.left + timelineRef.current.scrollLeft;
    const localY = event.clientY - rect.top;
    const rawMs = localX / pxPerMs;
    const snapMs = beatMs / snap;
    const startMs = snapTimeMs(rawMs);
    const key = keyFromTimelineY(localY, lowKeysOnTop);
    const defaultWidth = tool === "trill" ? 2 : difficulty === "normal" ? 5 : difficulty === "hard" ? 4 : 3;
    const hand: Op3Hand = key < 14 ? "left" : "right";
    const minKey = clamp(key - Math.floor(defaultWidth / 2), 0, laneCount - 1);
    const maxKey = clamp(minKey + defaultWidth - 1, 0, laneCount - 1);

    if (tool === "erase") {
      updateChart(chart.notes.filter((note) => !(startMs >= note.startMs - snapMs && startMs <= note.endMs + snapMs && key >= note.minKey && key <= note.maxKey)));
      return;
    }

    if (tool === "select") return;

    const duration = tool === "hold" || tool === "trill" ? beatMs * 2 : Math.max(100, beatMs * 0.45);
    const note: Op3Note = {
      id: crypto.randomUUID(),
      startMs: Math.round(startMs),
      endMs: Math.round(startMs + duration),
      hand,
      minKey,
      maxKey,
      pitch: hand === "left" ? 40 : 64,
      type: tool
    };

    updateChart([...chart.notes, note]);
    replaceSelection([note.id]);
  }

  function timelinePointFromPointer(event: React.PointerEvent<HTMLDivElement>) {
    if (!timelineRef.current) return null;
    const rect = timelineRef.current.getBoundingClientRect();
    return {
      x: event.clientX - rect.left + timelineRef.current.scrollLeft,
      y: event.clientY - rect.top + timelineRef.current.scrollTop
    };
  }

  function startBoxSelection(event: React.PointerEvent<HTMLDivElement>) {
    if (tool !== "select") return;
    const target = event.target as HTMLElement;
    if (!target.classList.contains("selectionCatcher")) return;
    const point = timelinePointFromPointer(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setBoxSelection({ startX: point.x, startY: point.y, currentX: point.x, currentY: point.y });
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) replaceSelection([]);
  }

  function moveBoxSelection(event: React.PointerEvent<HTMLDivElement>) {
    if (!boxSelection) return;
    const point = timelinePointFromPointer(event);
    if (!point) return;
    setBoxSelection((current) => current ? { ...current, currentX: point.x, currentY: point.y } : null);
  }

  function finishBoxSelection(event: React.PointerEvent<HTMLDivElement>) {
    if (!boxSelection) return;
    const selection = normalizedBox(boxSelection);
    const nextIds = chart.notes
      .filter((note) => noteIntersectsBox(note, selection, pxPerMs, lowKeysOnTop))
      .map((note) => note.id);
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      replaceSelection([...selectedIds, ...nextIds]);
    } else {
      replaceSelection(nextIds);
    }
    setBoxSelection(null);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released.
    }
  }

  function changeSelected(patch: Partial<Op3Note>) {
    if (selectedIds.length !== 1) return;
    updateChart(chart.notes.map((note) => note.id === selectedIds[0] ? { ...note, ...patch } : note));
  }

  function quantizeNote(note: Op3Note): Op3Note {
    const duration = Math.max(80, note.endMs - note.startMs);
    const startMs = Math.round(snapTimeMs(note.startMs));
    const endMs = Math.max(startMs + 80, Math.round(snapTimeMs(note.startMs + duration)));
    return { ...note, startMs, endMs };
  }

  function quantizeSelected() {
    if (selectedIds.length === 0) return;
    const selected = new Set(selectedIds);
    updateChart(chart.notes.map((note) => selected.has(note.id) ? quantizeNote(note) : note));
    setGenerationStatus(`Quantized ${selectedIds.length} selected note${selectedIds.length === 1 ? "" : "s"} to the current snap.`);
  }

  function quantizeCurrentChart() {
    updateChart(chart.notes.map(quantizeNote));
    setGenerationStatus(`Quantized ${difficulty} to the current snap.`);
  }

  function duplicateSelected() {
    const selected = selectedNotes();
    if (selected.length === 0) return;
    const snapMs = beatMs / snap;
    const copies = selected.map((note) => {
      const duration = note.endMs - note.startMs;
      const startMs = Math.round(snapTimeMs(note.startMs + snapMs));
      return {
        ...note,
        id: crypto.randomUUID(),
        startMs,
        endMs: Math.round(startMs + duration)
      };
    });
    updateChart([...chart.notes, ...copies]);
    replaceSelection(copies.map((note) => note.id));
    setGenerationStatus(`Duplicated ${copies.length} selected note${copies.length === 1 ? "" : "s"}.`);
  }

  function mirrorSelected() {
    if (selectedIds.length === 0) return;
    const selected = new Set(selectedIds);
    updateChart(chart.notes.map((note) => {
      if (!selected.has(note.id)) return note;
      const minKey = laneCount - 1 - note.maxKey;
      const maxKey = laneCount - 1 - note.minKey;
      const center = (minKey + maxKey) / 2;
      return {
        ...note,
        minKey,
        maxKey,
        hand: center < 14 ? "left" : "right"
      };
    }));
    setGenerationStatus(`Mirrored ${selectedIds.length} selected note${selectedIds.length === 1 ? "" : "s"} across the keyboard.`);
  }

  function clearCurrentChart() {
    if (chart.notes.length === 0) return;
    if (!window.confirm(`Clear all ${chart.notes.length} notes from ${difficulty}?`)) return;
    updateChart([]);
    replaceSelection([]);
    setGenerationStatus(`Cleared ${difficulty}.`);
  }

  function startNoteDrag(event: React.PointerEvent<HTMLElement>, note: Op3Note, mode: NoteDrag["mode"]) {
    event.preventDefault();
    event.stopPropagation();
    if (tool === "erase") {
      updateChart(chart.notes.filter((candidate) => candidate.id !== note.id));
      return;
    }
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      toggleNoteSelection(note.id);
    } else if (!selectedIds.includes(note.id)) {
      replaceSelection([note.id]);
    }
    const dragIds = selectedIds.includes(note.id) ? selectedIds : [note.id];
    const selected = chart.notes.filter((candidate) => dragIds.includes(candidate.id));
    noteDragRef.current = {
      mode,
      notes: selected.length > 0 ? selected : [note],
      startClientX: event.clientX,
      startClientY: event.clientY
    };
    const captureTarget = event.currentTarget instanceof HTMLButtonElement
      ? event.currentTarget
      : event.currentTarget.closest("button");
    captureTarget?.setPointerCapture(event.pointerId);
  }

  function moveDraggedNote(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = noteDragRef.current;
    if (!drag) return;
    event.preventDefault();
    event.stopPropagation();

    const dxMs = (event.clientX - drag.startClientX) / pxPerMs;
    if (drag.mode === "resize") {
      const targets = new Map(drag.notes.map((note) => [note.id, note]));
      updateChart(chart.notes.map((note) => {
        const original = targets.get(note.id);
        if (!original) return note;
        const nextEnd = Math.max(original.startMs + 80, snapTimeMs(original.endMs + dxMs));
        const duration = nextEnd - original.startMs;
        const type: Op3Note["type"] = original.type === "tap" ? duration > 500 ? "hold" : "tap" : original.type;
        return { ...note, endMs: Math.round(nextEnd), type };
      }));
      return;
    }

    const laneDelta = Math.round((drag.startClientY - event.clientY) / laneWidth) * (lowKeysOnTop ? -1 : 1);
    const targets = new Map(drag.notes.map((note) => [note.id, note]));
    updateChart(chart.notes.map((note) => {
      const original = targets.get(note.id);
      if (!original) return note;
      const duration = original.endMs - original.startMs;
      const width = original.maxKey - original.minKey + 1;
      const nextStart = snapTimeMs(original.startMs + dxMs);
      const nextMinKey = clamp(original.minKey + laneDelta, 0, laneCount - width);
      const nextMaxKey = nextMinKey + width - 1;
      const center = (nextMinKey + nextMaxKey) / 2;
      const hand: Op3Hand = center < 14 ? "left" : "right";
      return {
        ...note,
        startMs: Math.round(nextStart),
        endMs: Math.round(nextStart + duration),
        minKey: nextMinKey,
        maxKey: nextMaxKey,
        hand
      };
    }));
  }

  function endNoteDrag(event: React.PointerEvent<HTMLButtonElement>) {
    if (!noteDragRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    noteDragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }
  }

  async function exportProject() {
    setGenerationStatus(audioFile ? "Rendering note pitches for ZIP" : "Packaging ZIP");
    const exported = audioFile ? await renderProjectPitchesFromAudio(audioFile, project) : project;
    if (audioFile) {
      setProject(exported);
    }

    const packaged = {
      ...exported,
      audioPath: audioFile ? `audio/${audioFile.name}` : exported.audioPath,
      midiPath: midiFile ? `midi/${midiFile.name}` : (exported as Op3SongProject & { midiPath?: string }).midiPath,
      jacketPath: jacketFile ? `jacket/${jacketFile.name}` : exported.jacketPath
    };
    const zip = new JSZip();
    zip.file("project.op3song.json", `${JSON.stringify(packaged, null, 2)}\n`);
    if (audioFile) zip.file(`audio/${audioFile.name}`, audioFile);
    if (midiFile) zip.file(`midi/${midiFile.name}`, midiFile);
    if (jacketFile) zip.file(`jacket/${jacketFile.name}`, jacketFile);
    zip.file("README.txt", [
      "Nostalgia Chart Maker song package",
      "",
      "Load this .op3song.zip in the Nostalgia Chart Maker Web UI, then use Add Current to patch it into a game folder.",
      ""
    ].join("\r\n"));

    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${exported.id.toLowerCase()}.op3song.zip`;
    a.click();
    URL.revokeObjectURL(url);
    setGenerationStatus("Exported ZIP package");
  }

  async function importProject(file: File) {
    if (file.name.toLowerCase().endsWith(".zip")) {
      await importProjectZip(file);
      return;
    }

    const text = await file.text();
    const loaded = JSON.parse(text) as Op3SongProject;
    setProject(loaded);
    setAudioGuide([]);
    setMidiGuide([]);
    setMidiFile(null);
    replaceSelection([]);
    setGenerationStatus("Loaded project JSON");
  }

  async function importProjectZip(file: File) {
    setGenerationStatus("Loading ZIP package");
    const zip = await JSZip.loadAsync(file);
    const projectEntry = Object.values(zip.files).find((entry) => !entry.dir && entry.name.toLowerCase().endsWith(".op3song.json"))
      ?? zip.file("project.op3song.json");
    if (!projectEntry) throw new Error("ZIP does not contain an .op3song.json project file.");

    const loaded = JSON.parse(await projectEntry.async("text")) as Op3SongProject;
    const audioEntry = findZipAsset(zip, loaded.audioPath, isAudioName);
    const midiEntry = findZipAsset(zip, (loaded as Op3SongProject & { midiPath?: string }).midiPath, isMidiName);
    const jacketEntry = findZipAsset(zip, loaded.jacketPath, isImageName);
    let nextAudioFile: File | null = null;
    let nextJacketFile: File | null = null;
    let nextAudioUrl: string | null = null;
    let nextMidiFile: File | null = null;
    let nextJacketUrl: string | null = null;

    if (audioEntry) {
      nextAudioFile = await zipEntryToFile(audioEntry, basename(audioEntry.name), mimeForName(audioEntry.name));
      nextAudioUrl = URL.createObjectURL(nextAudioFile);
      loaded.audioPath = nextAudioFile.name;
    }

    if (midiEntry) {
      nextMidiFile = await zipEntryToFile(midiEntry, basename(midiEntry.name), mimeForName(midiEntry.name));
      (loaded as Op3SongProject & { midiPath?: string }).midiPath = nextMidiFile.name;
    }

    if (jacketEntry) {
      nextJacketFile = await zipEntryToFile(jacketEntry, basename(jacketEntry.name), mimeForName(jacketEntry.name));
      nextJacketUrl = URL.createObjectURL(nextJacketFile);
      loaded.jacketPath = nextJacketFile.name;
    }

    if (audioUrl) URL.revokeObjectURL(audioUrl);
    if (jacketUrl) URL.revokeObjectURL(jacketUrl);
    setProject(loaded);
    setAudioFile(nextAudioFile);
    setMidiFile(nextMidiFile);
    setAudioUrl(nextAudioUrl);
    setJacketFile(nextJacketFile);
    setJacketUrl(nextJacketUrl);
    setAudioGuide([]);
    setMidiGuide(nextMidiFile ? await parseMidiGuideFromFile(nextMidiFile) : []);
    replaceSelection([]);
    setIsPlaying(false);
    setPlaybackMs(0);
    setGenerationStatus(`Loaded ZIP package${nextAudioFile ? " with audio" : ""}${nextMidiFile ? " and MIDI" : ""}${nextJacketFile ? " and jacket" : ""}`);
    if (nextAudioFile) void ensureAudioGuide(showAudioGuide, nextAudioFile, true);
  }

  async function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) return;

    if (audio.paused) {
      await audio.play();
    } else {
      audio.pause();
    }
  }

  async function loadAudioFile(file: File) {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(URL.createObjectURL(file));
    setAudioFile(file);
    setAudioGuide([]);
    setBpmAlternatives([]);
    updateProject({ audioPath: file.name });
    setIsPlaying(false);
    setPlaybackMs(0);
    setGenerationStatus("Detecting BPM");
    try {
      const estimate = await estimateBpmFromAudio(file);
      if (!estimate) {
        setGenerationStatus("Loaded audio. BPM could not be detected.");
        await ensureAudioGuide(showAudioGuide, file, true);
        return;
      }

      const confidenceLabel = estimate.confidence >= 0.35 ? "good" : estimate.confidence >= 0.18 ? "rough" : "low";
      updateProject({ bpm: estimate.bpm, offsetMs: estimate.offsetMs });
      setBpmAlternatives(estimate.alternatives.filter((candidate) => Math.abs(candidate.bpm - estimate.bpm) > 0.1 || Math.abs(candidate.offsetMs - estimate.offsetMs) > 1));
      setGenerationStatus(`Loaded audio. Detected BPM ${estimate.bpm}, offset ${estimate.offsetMs}ms (${confidenceLabel} confidence).`);
      await ensureAudioGuide(showAudioGuide, file, true);
    } catch (error) {
      setGenerationStatus(error instanceof Error ? `Loaded audio. BPM detection failed: ${error.message}` : "Loaded audio. BPM detection failed.");
    }
  }

  async function ensureAudioGuide(nextShow = showAudioGuide, sourceFile = audioFile, force = false) {
    if (!nextShow || !sourceFile || (!force && audioGuide.length > 0)) return;
    const previousStatus = generationStatus;
    setGenerationStatus("Analyzing audio guide");
    try {
      const guide = await analyzeAudioGuideFromAudio(sourceFile);
      setAudioGuide(guide);
      setGenerationStatus(previousStatus ?? `Audio guide ready (${guide.length} points).`);
    } catch (error) {
      setGenerationStatus(error instanceof Error ? `Audio guide failed: ${error.message}` : "Audio guide failed.");
    }
  }

  function toggleAudioGuide(checked: boolean) {
    setShowAudioGuide(checked);
    if (checked) void ensureAudioGuide(true);
  }

  function loadJacketFile(file: File) {
    if (jacketUrl) URL.revokeObjectURL(jacketUrl);
    setJacketFile(file);
    setJacketUrl(URL.createObjectURL(file));
    updateProject({ jacketPath: file.name });
  }

  async function loadMidiFile(file: File) {
    setMidiFile(file);
    setProject((current) => ({ ...(current as Op3SongProject & { midiPath?: string }), midiPath: file.name }));
    try {
      const notes = await parseMidiGuideFromFile(file);
      setMidiGuide(notes);
      setShowMidiGuide(true);
      setGenerationStatus(`Loaded MIDI ${file.name}. Overlay shows ${notes.length} notes; generation will prefer MIDI mapping.`);
    } catch (error) {
      setMidiGuide([]);
      setGenerationStatus(error instanceof Error ? `Loaded MIDI, but overlay parse failed: ${error.message}` : "Loaded MIDI, but overlay parse failed.");
    }
  }

  async function generateFromAudio() {
    if (!audioFile) return;
      setIsGenerating(true);
      setGenerationStatus("Analyzing audio with server mapper");
    try {
      const audioBase64 = await fileToBase64(audioFile);
      const midiBase64 = midiFile ? await fileToBase64(midiFile) : undefined;
      const result = await apiJson<{ project: Op3SongProject }>("/api/generate-project", {
        method: "POST",
        body: JSON.stringify({
          project,
          audioFileName: audioFile.name,
          audioBase64,
          midiFileName: midiFile?.name,
          midiBase64,
          options: { density: generateDensity, sensitivity: generateSensitivity, trills: generateTrills }
        })
      });
      const generated = result.project;
      setProject(generated);
      replaceSelection([]);
      setGenerationStatus(`Generated ${difficulties.map((diff) => `${diff} ${generated.charts[diff].notes.length}`).join(", ")}`);
    } catch (error) {
      setGenerationStatus("Server mapper failed; using browser fallback.");
      try {
        const generated = await generateProjectFromAudio(audioFile, project, { density: generateDensity, sensitivity: generateSensitivity, trills: generateTrills });
        setProject(generated);
        replaceSelection([]);
        setGenerationStatus(`Generated with browser fallback: ${difficulties.map((diff) => `${diff} ${generated.charts[diff].notes.length}`).join(", ")}`);
      } catch (fallbackError) {
        setGenerationStatus(fallbackError instanceof Error ? fallbackError.message : error instanceof Error ? error.message : "Audio generation failed.");
      }
    } finally {
      setIsGenerating(false);
    }
  }

  async function refreshSongs() {
    setPatcherBusy(true);
    setPatcherStatus("Reading game song list");
    try {
      const result = await apiJson<{ songs: GameSong[] }>(`/api/songs?gameDir=${encodeURIComponent(gameDir)}`);
      setSongs(result.songs);
      setPatcherStatus(`Loaded ${result.songs.length} songs`);
    } catch (error) {
      setPatcherStatus(error instanceof Error ? error.message : "Could not read song list.");
    } finally {
      setPatcherBusy(false);
    }
  }

  async function installProjectFromPath() {
    setPatcherBusy(true);
    setPatcherStatus("Installing project");
    try {
      const result = await apiJson<{ stdout?: string; stderr?: string }>("/api/install-project", {
        method: "POST",
        body: JSON.stringify({ gameDir, projectPath, serverDir, syncServer, uniqueXsb })
      });
      setPatcherStatus((result.stdout || result.stderr || "Installed project.").trim());
      await refreshSongs();
    } catch (error) {
      setPatcherStatus(error instanceof Error ? error.message : "Install failed.");
    } finally {
      setPatcherBusy(false);
    }
  }

  async function installCurrentProject() {
    setPatcherBusy(true);
    setPatcherStatus(audioFile ? "Uploading current project and audio" : "Installing current project");
    try {
      const audioBase64 = audioFile ? await fileToBase64(audioFile) : undefined;
      const jacketBase64 = jacketFile ? await fileToBase64(jacketFile) : undefined;
      const result = await apiJson<{ stdout?: string; stderr?: string }>("/api/install-current-project", {
        method: "POST",
        body: JSON.stringify({
          gameDir,
          serverDir,
          syncServer,
          uniqueXsb,
          project,
          audioFileName: audioFile?.name,
          audioBase64,
          jacketFileName: jacketFile?.name,
          jacketBase64
        })
      });
      setPatcherStatus((result.stdout || result.stderr || "Installed current project.").trim());
      await refreshSongs();
    } catch (error) {
      setPatcherStatus(error instanceof Error ? error.message : "Install failed.");
    } finally {
      setPatcherBusy(false);
    }
  }

  async function syncServerMusicList() {
    setPatcherBusy(true);
    setPatcherStatus("Syncing server music list");
    try {
      const result = await apiJson<{ stdout?: string }>("/api/sync-server-music-list", {
        method: "POST",
        body: JSON.stringify({ gameDir, serverDir })
      });
      setPatcherStatus(result.stdout || "Synced server music list.");
    } catch (error) {
      setPatcherStatus(error instanceof Error ? error.message : "Server sync failed.");
    } finally {
      setPatcherBusy(false);
    }
  }


  async function removeSongFromGame(basename: string) {
    const confirmed = window.confirm(`Remove ${basename} from this game directory?`);
    if (!confirmed) return;
    setPatcherBusy(true);
    setPatcherStatus(`Removing ${basename}`);
    try {
      await apiJson("/api/remove-song", {
        method: "POST",
        body: JSON.stringify({ gameDir, basename, serverDir, syncServer })
      });
      setPatcherStatus(`Removed ${basename}`);
      await refreshSongs();
    } catch (error) {
      setPatcherStatus(error instanceof Error ? error.message : "Remove failed.");
    } finally {
      setPatcherBusy(false);
    }
  }

  const selectedSet = new Set(selectedIds);
  const selectedList = chart.notes.filter((note) => selectedSet.has(note.id));
  const selected = selectedList.length === 1 ? selectedList[0] : null;

  useEffect(() => {
    localStorage.setItem(lowKeysOnTopStorageKey, lowKeysOnTop ? "true" : "false");
  }, [lowKeysOnTop]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select")) return;
      if (showGuide && event.key === "Escape") {
        setShowGuide(false);
        return;
      }
      if (event.key === "1") setTool("select");
      else if (event.key === "2") setTool("tap");
      else if (event.key === "3") setTool("hold");
      else if (event.key === "4") setTool("trill");
      else if (event.key === "5") setTool("erase");
      else if (event.key.toLowerCase() === "q" && selectedIds.length > 0) quantizeSelected();
      else if (event.key.toLowerCase() === "m" && selectedIds.length > 0) mirrorSelected();
      else if (event.key === "Delete" && selectedIds.length > 0) {
        const selected = new Set(selectedIds);
        updateChart(chart.notes.filter((note) => !selected.has(note.id)));
        replaceSelection([]);
      } else if (event.ctrlKey && event.key.toLowerCase() === "d" && selectedIds.length > 0) {
        event.preventDefault();
        duplicateSelected();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [chart.notes, selectedIds, showGuide, snap, beatMs, difficulty]);

  return (
    <main className="app">
      <aside className="sidebar">
        <section className="brand">
          <Music2 size={24} />
          <div>
            <h1>Nostalgia Chart Maker</h1>
            <p>Chart editor and patcher prototype</p>
          </div>
        </section>

        <section className="panel">
          <h2>Song</h2>
          <label>Title<input value={project.title} onChange={(e) => updateProject({ title: e.target.value })} /></label>
          <label>Artist<input value={project.artist} onChange={(e) => updateProject({ artist: e.target.value })} /></label>
          <label>Mapper text<input value={project.description ?? defaultDescription} onChange={(e) => updateProject({ description: e.target.value })} /></label>
          <label>Genre<select value={project.categoryFlag ?? 64} onChange={(e) => updateCategory(e.target.value)}>
            {categoryOptions.map((option) => <option key={option.categoryFlag} value={option.categoryFlag}>{option.label}</option>)}
          </select></label>
          <div className="fieldRow">
            <label>BPM<input type="number" value={project.bpm} onChange={(e) => updateProject({ bpm: Number(e.target.value) })} /></label>
            <label>Offset<input type="number" value={project.offsetMs} onChange={(e) => setProjectOffset(Number(e.target.value))} /></label>
          </div>
          <div className="timingButtons">
            <button type="button" onClick={() => nudgeOffset(-10)}>-10</button>
            <button type="button" onClick={() => nudgeOffset(-1)}>-1</button>
            <button type="button" onClick={() => nudgeOffset(1)}>+1</button>
            <button type="button" onClick={() => nudgeOffset(10)}>+10</button>
            <button type="button" disabled={!audioUrl} onClick={alignOffsetToPlayhead}>Align Beat</button>
          </div>
          <label className="checkboxLine"><input type="checkbox" checked={shiftNotesWithOffset} onChange={(e) => setShiftNotesWithOffset(e.target.checked)} /> Shift notes when offset changes</label>
          <label>Song ID<input value={project.id} onChange={(e) => updateProject({ id: e.target.value })} /></label>
          <label>Audio path<input value={project.audioPath ?? ""} onChange={(e) => updateProject({ audioPath: e.target.value })} placeholder="C:\\path\\song.mp3" /></label>
          <label>Jacket path<input value={project.jacketPath ?? ""} onChange={(e) => updateProject({ jacketPath: e.target.value })} placeholder="C:\\path\\cover.jpg" /></label>
          <label>Generate density <span>{Math.round(generateDensity * 100)}%</span><input type="range" min="0.2" max="1.2" step="0.05" value={generateDensity} onChange={(e) => setGenerateDensity(Number(e.target.value))} /></label>
          <label>Beat sensitivity <span>{Math.round(generateSensitivity * 100)}%</span><input type="range" min="0.15" max="1.25" step="0.05" value={generateSensitivity} onChange={(e) => setGenerateSensitivity(Number(e.target.value))} /></label>
          <label className="checkboxLine"><input type="checkbox" checked={generateTrills} onChange={(e) => setGenerateTrills(e.target.checked)} /> Generate trills from rapid alternating notes</label>
          <div className="fileButtons">
            <FilePicker icon={<FileAudio size={16} />} label="Load Audio" accept="audio/*" onFile={loadAudioFile} />
            <FilePicker icon={<FolderOpen size={16} />} label="Load MIDI" accept=".mid,.midi,audio/midi" onFile={loadMidiFile} />
            <FilePicker icon={<FolderOpen size={16} />} label="Load Jacket" accept="image/*" onFile={loadJacketFile} />
            <FilePicker icon={<FolderOpen size={16} />} label="Load Project" accept=".zip,.json,.op3song,.op3song.zip" onFile={importProject} />
            <button className="generateButton" disabled={!audioFile || isGenerating} onClick={() => void generateFromAudio()}>
              <FileAudio size={16} /> {isGenerating ? "Generating" : "Generate"}
            </button>
          </div>
          {generationStatus ? <p className="generationStatus">{generationStatus}</p> : null}
          {bpmAlternatives.length > 0 ? (
            <div className="bpmAlternatives">
              {bpmAlternatives.map((alternative) => (
                <button type="button" key={`${alternative.bpm}-${alternative.offsetMs}`} onClick={() => applyBpmAlternative(alternative)}>
                  {alternative.bpm} / {alternative.offsetMs}ms
                </button>
              ))}
            </div>
          ) : null}
        </section>

        <section className="panel bookPreviewPanel">
          <h2>Book Preview</h2>
          <BookCardPreview project={project} jacketUrl={jacketUrl} />
        </section>

        <section className="panel">
          <h2>Patcher</h2>
          <label>Game directory<input value={gameDir} onChange={(e) => setGameDir(e.target.value)} /></label>
          <label>Server directory<input value={serverDir} onChange={(e) => setServerDir(e.target.value)} /></label>
          <label>Project JSON<input value={projectPath} onChange={(e) => setProjectPath(e.target.value)} placeholder="C:\\path\\song.op3song.json" /></label>
          <label className="checkboxLine"><input type="checkbox" checked={syncServer} onChange={(e) => setSyncServer(e.target.checked)} /> Sync MonkeyBusiness music list after changes</label>
          <label className="checkboxLine"><input type="checkbox" checked={uniqueXsb} onChange={(e) => setUniqueXsb(e.target.checked)} /> Use experimental unique XACT soundbanks</label>
          <div className="patcherActions">
            <button disabled={patcherBusy} onClick={() => void refreshSongs()}><RefreshCw size={16} /> Songs</button>
            <button disabled={patcherBusy} onClick={() => void installCurrentProject()}><Plus size={16} /> Add Current</button>
            <button disabled={patcherBusy || !projectPath.trim()} onClick={() => void installProjectFromPath()}><FolderOpen size={16} /> Add File</button>
            <button disabled={patcherBusy || !serverDir.trim()} onClick={() => void syncServerMusicList()}><Save size={16} /> Sync Server</button>
          </div>
          {patcherStatus ? <p className="generationStatus">{patcherStatus}</p> : null}
        </section>

        <section className="panel songPanel">
          <h2>Game Songs</h2>
          <div className="songList">
            {songs.length === 0 ? <p className="emptyList">Refresh to load songs.</p> : songs.slice(0, 80).map((song) => (
              <article key={`${song.index}-${song.basename}`} className={song.custom ? "songItem customSong" : "songItem"}>
                <div>
                  <strong>{song.title || song.basename}</strong>
                  <span>{song.artist || song.basename}</span>
                  <code>{song.basename}</code>
                </div>
                <div className="songMeta">
                  <span>{song.levels.filter(Boolean).join("/")}</span>
                  <button title={song.custom ? "Remove song" : "Only custom songs can be removed"} disabled={patcherBusy || !song.custom} onClick={() => void removeSongFromGame(song.basename)}><Trash2 size={15} /></button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="panel">
          <h2>Validation</h2>
          <div className="issueList">
            {issues.length === 0 ? <p>No issues found.</p> : issues.slice(0, 8).map((issue, index) => (
              <p key={`${issue.message}-${index}`} className={issue.severity}>{issue.message}</p>
            ))}
          </div>
        </section>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="tabs">
            {difficulties.map((diff) => (
              <button key={diff} className={difficulty === diff ? "active" : ""} onClick={() => { setDifficulty(diff); replaceSelection([]); }}>
                {diff}
                <span>{project.charts[diff].notes.length}</span>
              </button>
            ))}
          </div>
          <div className="actions">
            <button title="Select" className={tool === "select" ? "active" : ""} onClick={() => setTool("select")}><MousePointer2 size={18} /></button>
            <button title="Tap" className={tool === "tap" ? "active" : ""} onClick={() => setTool("tap")}><Plus size={18} /></button>
            <button title="Hold" className={tool === "hold" ? "active" : ""} onClick={() => setTool("hold")}><Grip size={18} /></button>
            <button title="Trill" className={tool === "trill" ? "active" : ""} onClick={() => setTool("trill")}><Repeat2 size={18} /></button>
            <button title="Erase" className={tool === "erase" ? "active" : ""} onClick={() => setTool("erase")}><Eraser size={18} /></button>
            <span className="toolbarDivider" />
            <button title="Quantize selected notes" disabled={selectedIds.length === 0} onClick={quantizeSelected}><Magnet size={18} /></button>
            <button title="Quantize current difficulty" disabled={chart.notes.length === 0} onClick={quantizeCurrentChart}><Magnet size={18} /><span className="miniBadge">all</span></button>
            <button title="Duplicate selected notes" disabled={selectedIds.length === 0} onClick={duplicateSelected}><Copy size={18} /></button>
            <button title="Mirror selected notes" disabled={selectedIds.length === 0} onClick={mirrorSelected}><FlipHorizontal2 size={18} /></button>
            <button title="Clear current difficulty" disabled={chart.notes.length === 0} onClick={clearCurrentChart}><Trash2 size={18} /></button>
            <span className="toolbarDivider" />
            <button title="Export project" onClick={() => void exportProject()}><Download size={18} /></button>
            <button title="How to make charts" className="helpButton" onClick={() => setShowGuide(true)}><HelpCircle size={18} /></button>
          </div>
        </header>

        <section className="transport">
          <button title={isPlaying ? "Pause" : "Play"} disabled={!audioUrl} onClick={() => void togglePlayback()}>
            {isPlaying ? <Pause size={18} /> : <Play size={18} />}
          </button>
          {audioUrl ? (
            <audio
              ref={audioRef}
              controls
              src={audioUrl}
              onLoadedMetadata={(event) => updateProject({ durationMs: Math.round(event.currentTarget.duration * 1000) })}
              onPause={() => setIsPlaying(false)}
              onPlay={() => setIsPlaying(true)}
              onEnded={() => setIsPlaying(false)}
              onTimeUpdate={(event) => setPlaybackMs(Math.round(event.currentTarget.currentTime * 1000))}
            />
          ) : <div className="emptyAudio">Load audio for editor playback</div>}
          <label className="snapControl">Snap<select value={snap} onChange={(e) => setSnap(Number(e.target.value))}><option value={2}>1/2</option><option value={4}>1/4</option><option value={8}>1/8</option><option value={16}>1/16</option></select></label>
          <label className="transportToggle"><input type="checkbox" checked={showBeatGuide} onChange={(e) => setShowBeatGuide(e.target.checked)} /> Beats</label>
          <label className="transportToggle"><input type="checkbox" checked={showAudioGuide} onChange={(e) => toggleAudioGuide(e.target.checked)} disabled={!audioFile} /> Audio</label>
          <label className="transportToggle"><input type="checkbox" checked={showMidiGuide} onChange={(e) => setShowMidiGuide(e.target.checked)} disabled={midiGuide.length === 0} /> MIDI</label>
          <label className="transportToggle orientationToggle" title="Flip the editor display so left-hand low keys appear above right-hand high keys. Exported key numbers stay unchanged."><input type="checkbox" checked={lowKeysOnTop} onChange={(e) => setLowKeysOnTop(e.target.checked)} /> Left top</label>
          {midiGuide.length > 0 ? <span className="midiGuideCount" title="Parsed MIDI notes">{midiGuide.length} MIDI notes</span> : null}
          <div className="audioLayerToggles" aria-label="Audio guide layers">
            <label title="Teal waveform energy"><input type="checkbox" checked={showAudioWaveform} onChange={(e) => setShowAudioWaveform(e.target.checked)} disabled={!showAudioGuide} /> Wave</label>
            <label title="Orange transient/onset strength"><input type="checkbox" checked={showAudioOnsets} onChange={(e) => setShowAudioOnsets(e.target.checked)} disabled={!showAudioGuide} /> Onsets</label>
            <label title="Pale high-frequency/brightness detail"><input type="checkbox" checked={showAudioBrightness} onChange={(e) => setShowAudioBrightness(e.target.checked)} disabled={!showAudioGuide} /> Bright</label>
          </div>
          <div className="timeReadout" title="Current playhead time">
            <strong>{formatTime(playbackMs)}</strong>
            <span>{playbackMs}ms</span>
          </div>
          <button className="textButton" title="Set offset to current playhead time" disabled={!audioUrl} onClick={setOffsetToPlayhead}>Set Offset</button>
          <button className="textButton" title="Align beat phase to current playhead time" disabled={!audioUrl} onClick={alignOffsetToPlayhead}>Phase</button>
          <label className="zoomControl">Zoom<input type="range" min="0.5" max="2.5" step="0.1" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} /></label>
          <label className="levelControl">Level<input type="number" value={chart.level} onChange={(e) => setProject((current) => ({
            ...current,
            charts: { ...current.charts, [difficulty]: { ...chart, level: Number(e.target.value) } }
          }))} /></label>
        </section>

        <section className="scrubbar">
          <span>0ms</span>
          <input
            type="range"
            min={0}
            max={Math.max(1, project.durationMs)}
            step={1}
            value={clamp(playbackMs, 0, project.durationMs)}
            onChange={(event) => seekToMs(Number(event.target.value))}
            disabled={!audioUrl}
          />
          <span>{project.durationMs}ms</span>
        </section>

        <section className="editorShell">
          <div className="editorGrid">
            <KeyboardRail lowKeysOnTop={lowKeysOnTop} />
            <div className="timeline" ref={timelineRef} onDoubleClick={addNoteFromPointer}>
              <div className="timelineInner" style={{ width: totalWidth, height: timelineHeight }}>
                {showAudioGuide ? <AudioGuide points={audioGuide} pxPerMs={pxPerMs} width={totalWidth} height={timelineHeight} layers={{ waveform: showAudioWaveform, onsets: showAudioOnsets, brightness: showAudioBrightness }} /> : null}
                {showMidiGuide && midiGuide.length > 0 ? <MidiGuide notes={midiGuide} pxPerMs={pxPerMs} lowKeysOnTop={lowKeysOnTop} /> : null}
                {showBeatGuide ? <Grid totalWidth={totalWidth} beatMs={beatMs} offsetMs={project.offsetMs} pxPerMs={pxPerMs} snap={snap} /> : null}
                <MsRuler totalWidth={totalWidth} pxPerMs={pxPerMs} durationMs={project.durationMs} />
                <div className="playhead" style={{ left: playbackMs * pxPerMs }} />
                {Array.from({ length: laneCount }).map((_, lane) => <div key={lane} className="lane" style={{ top: lane * laneWidth }} />)}
                {chart.notes.map((note) => (
                  <button
                    key={note.id}
                    className={`note ${note.type} ${note.hand} ${selectedSet.has(note.id) ? "selected" : ""}`}
                    style={noteStyle(note, pxPerMs, lowKeysOnTop)}
                    onPointerDown={(event) => startNoteDrag(event, note, "move")}
                    onPointerMove={moveDraggedNote}
                    onPointerUp={endNoteDrag}
                    onPointerCancel={endNoteDrag}
                    onClick={(event) => { event.stopPropagation(); }}
                  >
                    {note.type === "hold" ? "" : note.type === "trill" ? "tr" : keyWidth(note)}
                    <span
                      className="noteResizeHandle"
                      onPointerDown={(event) => startNoteDrag(event, note, "resize")}
                    />
                  </button>
                ))}
                <div
                  className="selectionCatcher"
                  onPointerDown={startBoxSelection}
                  onPointerMove={moveBoxSelection}
                  onPointerUp={finishBoxSelection}
                  onPointerCancel={() => setBoxSelection(null)}
                />
                {boxSelection ? <div className="boxSelection" style={boxStyle(boxSelection)} /> : null}
              </div>
            </div>
          </div>
        </section>

        <footer className="inspector">
          {selected ? (
            <>
              <strong>{selected.type} note</strong>
              <label>Start<input type="number" value={selected.startMs} onChange={(e) => changeSelected({ startMs: Number(e.target.value) })} /></label>
              <label>End<input type="number" value={selected.endMs} onChange={(e) => changeSelected({ endMs: Number(e.target.value) })} /></label>
              <label>Min<input type="number" value={selected.minKey} onChange={(e) => changeSelected({ minKey: Number(e.target.value) })} /></label>
              <label>Max<input type="number" value={selected.maxKey} onChange={(e) => changeSelected({ maxKey: Number(e.target.value) })} /></label>
              <label>Hand<select value={selected.hand} onChange={(e) => changeSelected({ hand: e.target.value as Op3Hand })}><option value="left">Left</option><option value="right">Right</option><option value="both">Both</option></select></label>
              <label>Type<select value={selected.type} onChange={(e) => changeSelected({ type: e.target.value as Op3Note["type"] })}><option value="tap">Tap</option><option value="hold">Hold</option><option value="trill">Trill</option></select></label>
              <button onClick={() => { updateChart(chart.notes.filter((note) => note.id !== selected.id)); replaceSelection([]); }}><Trash2 size={16} /></button>
            </>
          ) : selectedList.length > 1 ? (
            <>
              <strong>{selectedList.length} notes</strong>
              <span>Drag any selected note to move the group, or use toolbar actions to quantize, duplicate, mirror, or delete.</span>
              <button onClick={quantizeSelected}><Magnet size={16} /> Quantize</button>
              <button onClick={duplicateSelected}><Copy size={16} /> Duplicate</button>
              <button onClick={mirrorSelected}><FlipHorizontal2 size={16} /> Mirror</button>
              <button onClick={() => { const selected = new Set(selectedIds); updateChart(chart.notes.filter((note) => !selected.has(note.id))); replaceSelection([]); }}><Trash2 size={16} /> Delete</button>
            </>
          ) : (
            <span>Double-click the lane grid to place notes. Use Select mode to click, shift-click, or drag a box around notes.</span>
          )}
          <button onClick={() => void exportProject()}><Save size={16} /> Save project</button>
        </footer>
      </section>
      {showGuide ? <HowToGuide onClose={() => setShowGuide(false)} /> : null}
    </main>
  );
}

function HowToGuide({ onClose }: { onClose: () => void }) {
  return (
    <div className="modalBackdrop" role="presentation" onMouseDown={onClose}>
      <section className="guideModal" role="dialog" aria-modal="true" aria-labelledby="guide-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2 id="guide-title">Chart Making Quick Guide</h2>
            <p>Build the chart around timing first, then shape the keyboard movement.</p>
          </div>
          <button title="Close guide" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="guideGrid">
          <article>
            <h3>1. Prepare</h3>
            <p>Load audio, set title/artist, pick a genre, then set BPM and offset before placing lots of notes.</p>
          </article>
          <article>
            <h3>2. Align Timing</h3>
            <p>Turn on Beats and Audio guides. Wave shows energy, Onsets shows orange attack bars, and Bright shows high-frequency detail. Use Set Offset or Phase on a strong beat.</p>
          </article>
          <article>
            <h3>3. Place Notes</h3>
            <p>Use Tap for short hits, Hold for sustained sounds, and Trill for fast alternating two-key figures. Enable Low top if you prefer reading low-left keys at the top like a falling notesheet.</p>
          </article>
          <article>
            <h3>4. Edit Fast</h3>
            <p>Select notes to drag them. Grab the right edge to stretch into a hold. Use quantize, duplicate, mirror, and erase to clean patterns quickly.</p>
          </article>
          <article>
            <h3>5. Difficulty Style</h3>
            <p>Normal should be readable and musical. Hard adds hand movement. Expert and Real can add density, but avoid clutter and overlapping holds.</p>
          </article>
          <article>
            <h3>6. Test</h3>
            <p>Check Validation, export a project zip, then Add Current while the game is closed. Sync Server if your setup uses a local server.</p>
          </article>
        </div>

        <section className="guideTools">
          <h3>Tool Suite</h3>
          <div>
            <span><MousePointer2 size={15} /> Select and drag notes</span>
            <span><Plus size={15} /> Add taps</span>
            <span><Grip size={15} /> Add holds</span>
            <span><Repeat2 size={15} /> Add trills</span>
            <span><Eraser size={15} /> Erase notes</span>
            <span><Magnet size={15} /> Quantize timing</span>
            <span><Copy size={15} /> Duplicate selected</span>
            <span><FlipHorizontal2 size={15} /> Mirror selected</span>
          </div>
        </section>

        <section className="guideTools keyBindingGuide">
          <h3>Controls</h3>
          <div>
            <span><kbd>1</kbd> Select</span>
            <span><kbd>2</kbd> Tap</span>
            <span><kbd>3</kbd> Hold</span>
            <span><kbd>4</kbd> Trill</span>
            <span><kbd>5</kbd> Erase</span>
            <span><kbd>Shift</kbd> + click Add/remove selection</span>
            <span><kbd>Drag</kbd> empty grid Box select</span>
            <span><kbd>Low top</kbd> Flip editor lane direction</span>
            <span><kbd>Q</kbd> Quantize selected</span>
            <span><kbd>M</kbd> Mirror selected</span>
            <span><kbd>Ctrl</kbd> + <kbd>D</kbd> Duplicate selected</span>
            <span><kbd>Delete</kbd> Delete selected</span>
            <span><kbd>Esc</kbd> Close guide</span>
          </div>
        </section>

        <footer>
          <p>MIDI-assisted generation is usually cleaner than audio-only generation. Treat generated charts as drafts and polish by hand.</p>
          <button onClick={onClose}>Got it</button>
        </footer>
      </section>
    </div>
  );
}

async function apiJson<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `API request failed: ${response.status}`);
  }
  return body as T;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file."));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

function findZipAsset(zip: JSZip, preferredPath: string | undefined, predicate: (name: string) => boolean) {
  const files = Object.values(zip.files).filter((entry) => !entry.dir);
  const preferred = preferredPath ? normalizeZipPath(preferredPath) : "";
  if (preferred) {
    const exact = files.find((entry) => normalizeZipPath(entry.name) === preferred);
    if (exact) return exact;
    const preferredName = basename(preferred);
    const byName = files.find((entry) => basename(entry.name).toLowerCase() === preferredName.toLowerCase());
    if (byName) return byName;
  }
  return files.find((entry) => predicate(entry.name)) ?? null;
}

async function zipEntryToFile(entry: NonNullable<ReturnType<JSZip["file"]>>, name: string, type: string): Promise<File> {
  const blob = await entry.async("blob");
  return new File([blob], name, { type });
}

function normalizeZipPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.?\//, "");
}

function basename(path: string): string {
  const normalized = normalizeZipPath(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function isAudioName(name: string): boolean {
  return /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(name);
}

function isImageName(name: string): boolean {
  return /\.(jpg|jpeg|png|webp|bmp)$/i.test(name);
}

function isMidiName(name: string): boolean {
  return /\.(mid|midi)$/i.test(name);
}

function mimeForName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".flac")) return "audio/flac";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".aac")) return "audio/aac";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".mid") || lower.endsWith(".midi")) return "audio/midi";
  return "application/octet-stream";
}

function formatTime(timeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(timeMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const ms = Math.max(0, timeMs % 1000);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

const MsRuler = React.memo(function MsRuler({ totalWidth, pxPerMs, durationMs }: { totalWidth: number; pxPerMs: number; durationMs: number }) {
  const majorMs = pxPerMs > 0.1 ? 1000 : pxPerMs > 0.055 ? 2000 : 5000;
  const minorMs = majorMs / 5;
  const lines = [];

  for (let timeMs = 0; timeMs <= durationMs + minorMs; timeMs += minorMs) {
    const x = timeMs * pxPerMs;
    if (x < 0 || x > totalWidth) continue;
    const major = timeMs % majorMs === 0;
    lines.push(
      <div key={timeMs} className={major ? "msTick majorMsTick" : "msTick"} style={{ left: x }}>
        {major ? <span>{timeMs}ms</span> : null}
      </div>
    );
  }

  return <div className="msRuler" aria-hidden="true">{lines}</div>;
});

const MidiGuide = React.memo(function MidiGuide({ notes, pxPerMs, lowKeysOnTop }: { notes: MidiGuideNote[]; pxPerMs: number; lowKeysOnTop: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || notes.length === 0) return;

    const maxEndMs = Math.max(...notes.map((note) => note.endMs));
    const cssWidth = Math.max(1, Math.ceil(maxEndMs * pxPerMs + 48));
    const cssHeight = timelineHeight;
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const pitches = notes.map((note) => note.pitch).sort((a, b) => a - b);
    const low = pitches[Math.floor(pitches.length * 0.02)] ?? 36;
    const high = pitches[Math.floor(pitches.length * 0.98)] ?? 84;
    const span = Math.max(12, high - low);

    for (const note of notes) {
      const lane = clamp(Math.round((note.pitch - low) / span * (laneCount - 1)), 0, laneCount - 1);
      const x = Math.round(note.startMs * pxPerMs) + 0.5;
      const y = laneTopForRange(lane, lane, lowKeysOnTop) + 7.5;
      const width = Math.max(2, (note.endMs - note.startMs) * pxPerMs);
      const alpha = 0.24 + clamp(note.velocity / 127, 0, 1) * 0.46;
      ctx.fillStyle = `rgba(170, 116, 255, ${alpha})`;
      ctx.strokeStyle = `rgba(232, 208, 255, ${Math.min(0.82, alpha + 0.2)})`;
      ctx.beginPath();
      roundedRect(ctx, x, y, width, 14, 3);
      ctx.fill();
      ctx.stroke();
    }
  }, [notes, pxPerMs, lowKeysOnTop]);

  return <canvas ref={canvasRef} className="midiGuide" aria-hidden="true" />;
});

function KeyboardRail({ lowKeysOnTop }: { lowKeysOnTop: boolean }) {
  const leftTop = laneTopForRange(0, 13, lowKeysOnTop);
  const rightTop = laneTopForRange(14, 27, lowKeysOnTop);
  return (
    <aside className="keyboardRail" style={{ height: timelineHeight }} aria-label="Keyboard hand zones">
      <div className="keyZone leftZone" style={{ top: leftTop, height: laneWidth * 14 }}>
        <span>Left</span>
        <small>0-13</small>
      </div>
      <div className="keyZone rightZone" style={{ top: rightTop, height: laneWidth * 14 }}>
        <span>Right</span>
        <small>14-27</small>
      </div>
      <div className="keyRailHint topHint">{lowKeysOnTop ? "0" : "27"}</div>
      <div className="keyRailHint midHint">13/14</div>
      <div className="keyRailHint bottomHint">{lowKeysOnTop ? "27" : "0"}</div>
    </aside>
  );
}

type AudioGuideLayers = {
  waveform: boolean;
  onsets: boolean;
  brightness: boolean;
};

const AudioGuide = React.memo(function AudioGuide({ points, pxPerMs, width, height, layers }: { points: AudioGuidePoint[]; pxPerMs: number; width: number; height: number; layers: AudioGuideLayers }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || points.length === 0) return;

    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const cssWidth = Math.max(1, Math.ceil(width));
    const cssHeight = Math.max(1, Math.ceil(height));
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const centerY = cssHeight / 2;
    const bucketPx = Math.max(1, Math.min(4, Math.round(52 * pxPerMs)));
    const buckets = new Map<number, { energy: number; onset: number; brightness: number }>();
    for (const point of points) {
      const x = Math.round((point.timeMs * pxPerMs) / bucketPx) * bucketPx;
      const existing = buckets.get(x);
      if (existing) {
        existing.energy = Math.max(existing.energy, point.energy);
        existing.onset = Math.max(existing.onset, point.onset);
        existing.brightness = Math.max(existing.brightness, point.brightness);
      } else {
        buckets.set(x, { energy: point.energy, onset: point.onset, brightness: point.brightness });
      }
    }

    ctx.lineWidth = 1;
    for (const [x, point] of buckets) {
      const crispX = Math.round(x) + 0.5;
      const energyHeight = Math.max(2, point.energy * cssHeight * 0.34);
      const brightnessHeight = Math.max(1, point.brightness * cssHeight * 0.14);
      const onsetHeight = point.onset * cssHeight * 0.86;
      const strong = point.onset > 0.58 || point.onset * 0.7 + point.energy * 0.3 > 0.62;

      if (layers.waveform) {
        ctx.strokeStyle = "rgba(84, 214, 188, 0.58)";
        ctx.beginPath();
        ctx.moveTo(crispX, centerY - energyHeight / 2);
        ctx.lineTo(crispX, centerY + energyHeight / 2);
        ctx.stroke();
      }

      if (layers.brightness && point.brightness > 0.08) {
        ctx.strokeStyle = "rgba(180, 219, 255, 0.28)";
        ctx.beginPath();
        ctx.moveTo(crispX + 1, centerY - brightnessHeight / 2);
        ctx.lineTo(crispX + 1, centerY + brightnessHeight / 2);
        ctx.stroke();
      }

      if (layers.onsets && point.onset > 0.12) {
        ctx.strokeStyle = strong ? "rgba(255, 219, 119, 0.84)" : "rgba(240, 189, 92, 0.52)";
        ctx.beginPath();
        ctx.moveTo(crispX, cssHeight);
        ctx.lineTo(crispX, Math.max(cssHeight * 0.18, cssHeight - onsetHeight));
        ctx.stroke();
      }

      if (layers.onsets && strong) {
        ctx.fillStyle = "rgba(245, 217, 125, 0.82)";
        ctx.fillRect(Math.round(x), 0, Math.max(2, bucketPx), 10);
      }
    }
  }, [points, pxPerMs, width, height, layers]);

  if (points.length === 0) {
    return <div className="audioGuide audioGuideEmpty">Audio guide loading</div>;
  }

  return <canvas ref={canvasRef} className="audioGuide audioGuideCanvas" aria-hidden="true" />;
});

const Grid = React.memo(function Grid({ totalWidth, beatMs, offsetMs, pxPerMs, snap }: { totalWidth: number; beatMs: number; offsetMs: number; pxPerMs: number; snap: number }) {
  const lines = [];
  const subdivision = Math.max(1, Math.min(16, snap));
  const stepMs = beatMs / subdivision;
  const startStep = Math.floor((0 - offsetMs) / stepMs) - 1;
  const endStep = Math.ceil((totalWidth / pxPerMs - offsetMs) / stepMs) + 1;

  for (let step = startStep; step <= endStep; step++) {
    const timeMs = offsetMs + step * stepMs;
    const x = timeMs * pxPerMs;
    if (x < 0 || x > totalWidth) continue;

    const beatIndex = Math.round(step / subdivision);
    const isBeat = step % subdivision === 0;
    const isMeasure = isBeat && beatIndex % 4 === 0;
    const className = isMeasure ? "beatLine measureLine" : isBeat ? "beatLine mainBeatLine" : "beatLine subBeatLine";

    lines.push(
      <div key={step} className={className} style={{ left: x }}>
        {isMeasure ? <span>{Math.floor(beatIndex / 4) + 1}</span> : null}
      </div>
    );
  }

  return <>{lines}</>;
});

function BookCardPreview({ project, jacketUrl }: { project: Op3SongProject; jacketUrl: string | null }) {
  const rows: Array<{ difficulty: Op3Difficulty; label: string }> = [
    { difficulty: "normal", label: "Normal" },
    { difficulty: "hard", label: "Hard" },
    { difficulty: "expert", label: "Expert" },
    { difficulty: "real", label: "Real" }
  ];
  const title = project.title.trim() || project.id;
  const artist = project.artist.trim() || "Unknown Artist";

  return (
    <article className="bookCard">
      <div className="bookCardGlow" />
      <div className="bookJacket">
        {jacketUrl ? <img src={jacketUrl} alt="" /> : <div className="bookJacketPlaceholder">OP3</div>}
      </div>
      <div className="bookInfo">
        <div className="bookTitleLine">
          <span className="bookDivider" />
          <div>
            <strong>{title}</strong>
            <span>{artist}</span>
          </div>
        </div>
        <p>{project.description?.trim() || defaultDescription}</p>
        <div className="bookLevels">
          {rows.map(({ difficulty, label }) => {
            const chart = project.charts[difficulty];
            const available = chart.notes.length > 0;
            return (
              <div key={difficulty} className={`bookLevel ${difficulty}`}>
                <span>{label}</span>
                <b>{available ? chart.level : "選択不可"}</b>
              </div>
            );
          })}
        </div>
      </div>
      <div className="bookDots" aria-hidden="true">
        {Array.from({ length: 8 }).map((_, index) => <span key={index} />)}
      </div>
    </article>
  );
}

function FilePicker({ icon, label, accept, onFile }: { icon: React.ReactNode; label: string; accept: string; onFile: (file: File) => void | Promise<void> }) {
  return (
    <label className="filePicker">
      {icon}
      {label}
      <input type="file" accept={accept} onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) void onFile(file);
      }} />
    </label>
  );
}

function noteStyle(note: Op3Note, pxPerMs: number, lowKeysOnTop: boolean): React.CSSProperties {
  const laneTop = laneTopForRange(note.minKey, note.maxKey, lowKeysOnTop) + 4;
  const laneHeight = (note.maxKey - note.minKey + 1) * laneWidth - 8;
  return {
    left: note.startMs * pxPerMs,
    width: Math.max(10, (note.endMs - note.startMs) * pxPerMs),
    top: laneTop,
    height: laneHeight
  };
}

function laneTopForRange(minKey: number, maxKey: number, lowKeysOnTop: boolean): number {
  return (lowKeysOnTop ? minKey : laneCount - 1 - maxKey) * laneWidth;
}

function keyFromTimelineY(y: number, lowKeysOnTop: boolean): number {
  const lane = clamp(Math.floor(y / laneWidth), 0, laneCount - 1);
  return lowKeysOnTop ? lane : laneCount - 1 - lane;
}

function normalizedBox(box: BoxSelection) {
  return {
    left: Math.min(box.startX, box.currentX),
    right: Math.max(box.startX, box.currentX),
    top: Math.min(box.startY, box.currentY),
    bottom: Math.max(box.startY, box.currentY)
  };
}

function boxStyle(box: BoxSelection): React.CSSProperties {
  const normalized = normalizedBox(box);
  return {
    left: normalized.left,
    top: normalized.top,
    width: Math.max(1, normalized.right - normalized.left),
    height: Math.max(1, normalized.bottom - normalized.top)
  };
}

function noteIntersectsBox(note: Op3Note, box: ReturnType<typeof normalizedBox>, pxPerMs: number, lowKeysOnTop = false): boolean {
  const noteLeft = note.startMs * pxPerMs;
  const noteRight = note.endMs * pxPerMs;
  const noteTop = laneTopForRange(note.minKey, note.maxKey, lowKeysOnTop);
  const noteBottom = noteTop + (note.maxKey - note.minKey + 1) * laneWidth;
  return noteLeft <= box.right && noteRight >= box.left && noteTop <= box.bottom && noteBottom >= box.top;
}

async function parseMidiGuideFromFile(file: File): Promise<MidiGuideNote[]> {
  return parseMidiGuide(new Uint8Array(await file.arrayBuffer()));
}

function parseMidiGuide(data: Uint8Array): MidiGuideNote[] {
  if (readAscii(data, 0, 4) !== "MThd") throw new Error("Not a MIDI file.");
  const headerLength = readU32(data, 4);
  const trackCount = readU16(data, 10);
  const division = readU16(data, 12);
  if (division & 0x8000) throw new Error("SMPTE MIDI timing is not supported.");

  let cursor = 8 + headerLength;
  const events: Array<{ tick: number; kind: "on" | "off"; pitch: number; velocity: number; channel: number; track: number }> = [];
  const tempos: Array<{ tick: number; tempo: number }> = [{ tick: 0, tempo: 500000 }];
  for (let track = 0; track < trackCount; track++) {
    if (readAscii(data, cursor, 4) !== "MTrk") throw new Error(`Missing MIDI track ${track}.`);
    const length = readU32(data, cursor + 4);
    const end = cursor + 8 + length;
    const parsed = parseMidiTrack(data, cursor + 8, end, track);
    events.push(...parsed.events);
    tempos.push(...parsed.tempos);
    cursor = end;
  }

  const tempoMap = tempos.sort((a, b) => a.tick - b.tick);
  const active = new Map<string, Array<{ tick: number; velocity: number; pitch: number; channel: number; track: number }>>();
  const notes: MidiGuideNote[] = [];
  for (const event of events.sort((a, b) => a.tick - b.tick || (a.kind === "off" ? -1 : 1))) {
    const key = `${event.track}:${event.channel}:${event.pitch}`;
    if (event.kind === "on") {
      const stack = active.get(key) ?? [];
      stack.push(event);
      active.set(key, stack);
      continue;
    }
    const stack = active.get(key);
    const start = stack?.shift();
    if (!start || event.tick <= start.tick) continue;
    notes.push({
      startMs: Math.round(tickToMs(start.tick, tempoMap, division)),
      endMs: Math.round(tickToMs(event.tick, tempoMap, division)),
      pitch: start.pitch,
      velocity: start.velocity
    });
  }
  return notes.filter((note) => note.endMs > note.startMs).sort((a, b) => a.startMs - b.startMs || a.pitch - b.pitch);
}

function parseMidiTrack(data: Uint8Array, start: number, end: number, track: number) {
  let cursor = start;
  let tick = 0;
  let runningStatus = 0;
  const events: Array<{ tick: number; kind: "on" | "off"; pitch: number; velocity: number; channel: number; track: number }> = [];
  const tempos: Array<{ tick: number; tempo: number }> = [];
  while (cursor < end) {
    const delta = readVarLen(data, cursor);
    tick += delta.value;
    cursor = delta.next;
    let status = data[cursor];
    if (status < 0x80) {
      if (!runningStatus) throw new Error("Invalid MIDI running status.");
      status = runningStatus;
    } else {
      cursor += 1;
      if (status < 0xF0) runningStatus = status;
    }

    if (status === 0xFF) {
      const metaType = data[cursor++];
      const length = readVarLen(data, cursor);
      cursor = length.next;
      if (metaType === 0x51 && length.value === 3) {
        tempos.push({ tick, tempo: (data[cursor] << 16) | (data[cursor + 1] << 8) | data[cursor + 2] });
      }
      cursor += length.value;
      if (metaType === 0x2F) break;
      continue;
    }

    if (status === 0xF0 || status === 0xF7) {
      const length = readVarLen(data, cursor);
      cursor = length.next + length.value;
      continue;
    }

    const eventType = status & 0xF0;
    const channel = status & 0x0F;
    const dataLength = eventType === 0xC0 || eventType === 0xD0 ? 1 : 2;
    const first = data[cursor++];
    const second = dataLength === 2 ? data[cursor++] : 0;
    if (eventType === 0x90 || eventType === 0x80) {
      const kind = eventType === 0x90 && second > 0 ? "on" : "off";
      events.push({ tick, kind, pitch: first, velocity: second, channel, track });
    }
  }
  return { events, tempos };
}

function tickToMs(tick: number, tempos: Array<{ tick: number; tempo: number }>, division: number): number {
  let elapsed = 0;
  let previousTick = 0;
  let tempo = 500000;
  for (const entry of tempos) {
    if (entry.tick > tick) break;
    elapsed += (entry.tick - previousTick) * tempo / division / 1000;
    previousTick = entry.tick;
    tempo = entry.tempo;
  }
  return elapsed + (tick - previousTick) * tempo / division / 1000;
}

function readVarLen(data: Uint8Array, cursor: number): { value: number; next: number } {
  let value = 0;
  for (let i = 0; i < 4; i++) {
    const byte = data[cursor++];
    value = (value << 7) | (byte & 0x7F);
    if (!(byte & 0x80)) return { value, next: cursor };
  }
  return { value, next: cursor };
}

function readAscii(data: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...data.slice(offset, offset + length));
}

function readU16(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1];
}

function readU32(data: Uint8Array, offset: number): number {
  return (data[offset] * 0x1000000) + ((data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]);
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const right = x + width;
  const bottom = y + height;
  const r = Math.min(radius, width / 2, height / 2);
  ctx.moveTo(x + r, y);
  ctx.lineTo(right - r, y);
  ctx.quadraticCurveTo(right, y, right, y + r);
  ctx.lineTo(right, bottom - r);
  ctx.quadraticCurveTo(right, bottom, right - r, bottom);
  ctx.lineTo(x + r, bottom);
  ctx.quadraticCurveTo(x, bottom, x, bottom - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

function seedProject(): Op3SongProject {
  return createEmptyProject();
}

function shiftProjectNotes(project: Op3SongProject, deltaMs: number): Op3SongProject {
  return {
    ...project,
    charts: Object.fromEntries(Object.entries(project.charts).map(([difficulty, chart]) => [
      difficulty,
      {
        ...chart,
        notes: chart.notes.map((note) => {
          const duration = note.endMs - note.startMs;
          const startMs = Math.max(0, Math.round(note.startMs + deltaMs));
          return {
            ...note,
            startMs,
            endMs: Math.max(startMs + 1, Math.round(startMs + duration))
          };
        })
      }
    ])) as Op3SongProject["charts"]
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

createRoot(document.getElementById("root")!).render(<App />);
