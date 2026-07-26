import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Download, Eraser, FileAudio, FolderOpen, Grip, MousePointer2, Music2, Pause, Play, Plus, RefreshCw, Repeat2, Save, Trash2 } from "lucide-react";
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
  note: Op3Note;
  startClientX: number;
  startClientY: number;
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
const msPerBeatDefault = 60000 / 137;
const apiBase = "http://127.0.0.1:5174";

function App() {
  const [project, setProject] = useState<Op3SongProject>(() => seedProject());
  const [difficulty, setDifficulty] = useState<Op3Difficulty>("normal");
  const [tool, setTool] = useState<Tool>("tap");
  const [snap, setSnap] = useState(4);
  const [zoom, setZoom] = useState(1);
  const [showBeatGuide, setShowBeatGuide] = useState(true);
  const [showAudioGuide, setShowAudioGuide] = useState(false);
  const [audioGuide, setAudioGuide] = useState<AudioGuidePoint[]>([]);
  const [shiftNotesWithOffset, setShiftNotesWithOffset] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
  const [projectPath, setProjectPath] = useState(".\\m_custom0001_aishite.op3song.json");
  const [songs, setSongs] = useState<GameSong[]>([]);
  const [patcherStatus, setPatcherStatus] = useState<string | null>(null);
  const [patcherBusy, setPatcherBusy] = useState(false);
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
    const key = clamp(laneCount - 1 - Math.floor(localY / laneWidth), 0, laneCount - 1);
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
    setSelectedId(note.id);
  }

  function changeSelected(patch: Partial<Op3Note>) {
    if (!selectedId) return;
    updateChart(chart.notes.map((note) => note.id === selectedId ? { ...note, ...patch } : note));
  }

  function startNoteDrag(event: React.PointerEvent<HTMLElement>, note: Op3Note, mode: NoteDrag["mode"]) {
    event.preventDefault();
    event.stopPropagation();
    if (tool === "erase") {
      updateChart(chart.notes.filter((candidate) => candidate.id !== note.id));
      return;
    }
    setSelectedId(note.id);
    noteDragRef.current = {
      mode,
      note,
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
      const nextEnd = Math.max(drag.note.startMs + 80, snapTimeMs(drag.note.endMs + dxMs));
      const duration = nextEnd - drag.note.startMs;
      const type: Op3Note["type"] = duration > 500 ? "hold" : "tap";
      updateNote(drag.note.id, { endMs: Math.round(nextEnd), type });
      return;
    }

    const duration = drag.note.endMs - drag.note.startMs;
    const width = drag.note.maxKey - drag.note.minKey + 1;
    const nextStart = snapTimeMs(drag.note.startMs + dxMs);
    const laneDelta = Math.round((drag.startClientY - event.clientY) / laneWidth);
    const nextMinKey = clamp(drag.note.minKey + laneDelta, 0, laneCount - width);
    const nextMaxKey = nextMinKey + width - 1;
    const center = (nextMinKey + nextMaxKey) / 2;
    const hand: Op3Hand = center < 14 ? "left" : "right";
    updateNote(drag.note.id, {
      startMs: Math.round(nextStart),
      endMs: Math.round(nextStart + duration),
      minKey: nextMinKey,
      maxKey: nextMaxKey,
      hand
    });
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
      "OP3 Mapper song package",
      "",
      "Load this .op3song.zip in the OP3 Mapper Web UI, then use Add Current to patch it into a game folder.",
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
    setSelectedId(null);
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
    setSelectedId(null);
    setIsPlaying(false);
    setPlaybackMs(0);
    setGenerationStatus(`Loaded ZIP package${nextAudioFile ? " with audio" : ""}${nextJacketFile ? " and jacket" : ""}`);
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

  function loadMidiFile(file: File) {
    setMidiFile(file);
    setProject((current) => ({ ...(current as Op3SongProject & { midiPath?: string }), midiPath: file.name }));
    setGenerationStatus(`Loaded MIDI ${file.name}. Generate will prefer MIDI mapping.`);
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
      setSelectedId(null);
      setGenerationStatus(`Generated ${difficulties.map((diff) => `${diff} ${generated.charts[diff].notes.length}`).join(", ")}`);
    } catch (error) {
      setGenerationStatus("Server mapper failed; using browser fallback.");
      try {
        const generated = await generateProjectFromAudio(audioFile, project, { density: generateDensity, sensitivity: generateSensitivity, trills: generateTrills });
        setProject(generated);
        setSelectedId(null);
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

  const selected = chart.notes.find((note) => note.id === selectedId) ?? null;

  return (
    <main className="app">
      <aside className="sidebar">
        <section className="brand">
          <Music2 size={24} />
          <div>
            <h1>OP3 Mapper</h1>
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
              <button key={diff} className={difficulty === diff ? "active" : ""} onClick={() => { setDifficulty(diff); setSelectedId(null); }}>
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
            <button title="Export project" onClick={() => void exportProject()}><Download size={18} /></button>
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
          <div className="timeline" ref={timelineRef} onDoubleClick={addNoteFromPointer}>
            <div className="timelineInner" style={{ width: totalWidth, height: timelineHeight }}>
              {showAudioGuide ? <AudioGuide points={audioGuide} pxPerMs={pxPerMs} width={totalWidth} height={timelineHeight} /> : null}
              {showBeatGuide ? <Grid totalWidth={totalWidth} beatMs={beatMs} offsetMs={project.offsetMs} pxPerMs={pxPerMs} snap={snap} /> : null}
              <MsRuler totalWidth={totalWidth} pxPerMs={pxPerMs} durationMs={project.durationMs} />
              <div className="playhead" style={{ left: playbackMs * pxPerMs }} />
              {Array.from({ length: laneCount }).map((_, lane) => <div key={lane} className="lane" style={{ top: lane * laneWidth }} />)}
              {chart.notes.map((note) => (
                <button
                  key={note.id}
                  className={`note ${note.type} ${note.hand} ${selectedId === note.id ? "selected" : ""}`}
                  style={noteStyle(note, pxPerMs)}
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
              <button onClick={() => updateChart(chart.notes.filter((note) => note.id !== selected.id))}><Trash2 size={16} /></button>
            </>
          ) : (
            <span>Double-click the lane grid to place notes. Select a note to edit timing and width.</span>
          )}
          <button onClick={() => void exportProject()}><Save size={16} /> Save project</button>
        </footer>
      </section>
    </main>
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

const AudioGuide = React.memo(function AudioGuide({ points, pxPerMs, width, height }: { points: AudioGuidePoint[]; pxPerMs: number; width: number; height: number }) {
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

      ctx.strokeStyle = "rgba(84, 214, 188, 0.42)";
      ctx.beginPath();
      ctx.moveTo(crispX, centerY - energyHeight / 2);
      ctx.lineTo(crispX, centerY + energyHeight / 2);
      ctx.stroke();

      if (point.brightness > 0.08) {
        ctx.strokeStyle = "rgba(180, 219, 255, 0.28)";
        ctx.beginPath();
        ctx.moveTo(crispX + 1, centerY - brightnessHeight / 2);
        ctx.lineTo(crispX + 1, centerY + brightnessHeight / 2);
        ctx.stroke();
      }

      if (point.onset > 0.12) {
        ctx.strokeStyle = strong ? "rgba(255, 219, 119, 0.96)" : "rgba(240, 189, 92, 0.7)";
        ctx.beginPath();
        ctx.moveTo(crispX, cssHeight);
        ctx.lineTo(crispX, Math.max(0, cssHeight - onsetHeight));
        ctx.stroke();
      }

      if (strong) {
        ctx.fillStyle = "rgba(245, 217, 125, 0.95)";
        ctx.fillRect(Math.round(x), 0, Math.max(2, bucketPx), 10);
      }
    }
  }, [points, pxPerMs, width, height]);

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

function noteStyle(note: Op3Note, pxPerMs: number): React.CSSProperties {
  const laneTop = (laneCount - 1 - note.maxKey) * laneWidth + 4;
  const laneHeight = (note.maxKey - note.minKey + 1) * laneWidth - 8;
  return {
    left: note.startMs * pxPerMs,
    width: Math.max(10, (note.endMs - note.startMs) * pxPerMs),
    top: laneTop,
    height: laneHeight
  };
}

function seedProject(): Op3SongProject {
  const project = createEmptyProject();
  const beatMs = msPerBeatDefault;
  for (const difficulty of difficulties) {
    const width = difficulty === "normal" ? 5 : difficulty === "hard" ? 4 : 3;
    const count = difficulty === "normal" ? 28 : difficulty === "hard" ? 44 : difficulty === "expert" ? 64 : 88;
    const notes: Op3Note[] = [];
    for (let i = 0; i < count; i++) {
      const hand: Op3Hand = i % 2 === 0 ? "left" : "right";
      const center = hand === "left" ? 8 + (i % 4) : 18 + (i % 5);
      notes.push({
        id: crypto.randomUUID(),
        startMs: Math.round(beatMs * (4 + i * (difficulty === "normal" ? 1.5 : 1))),
        endMs: Math.round(beatMs * (4 + i * (difficulty === "normal" ? 1.5 : 1)) + beatMs * 0.5),
        hand,
        minKey: clamp(center - Math.floor(width / 2), 0, laneCount - 1),
        maxKey: clamp(center - Math.floor(width / 2) + width - 1, 0, laneCount - 1),
        pitch: hand === "left" ? 40 : 64,
        type: i % 16 === 0 ? "hold" : "tap"
      });
    }
    project.charts[difficulty].notes = notes;
  }
  return project;
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
