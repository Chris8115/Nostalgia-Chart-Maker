import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Op3SongProject } from "./shared/project.js";

type SongListItem = {
  index: number;
  basename: string;
  title: string;
  artist: string;
  levels: [number, number, number, number];
  installed: boolean;
  custom: boolean;
};

const mapperRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(mapperRoot, "dist", "cli.js");
const ffmpegPath = join(mapperRoot, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const pythonGeneratorPath = join(mapperRoot, "scripts", "generate_chart.py");
const port = Number(process.env.OP3_MAPPER_API_PORT ?? 5174);

createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    sendJson(response, 500, { error: error instanceof Error ? error.message : "Unknown server error." });
  });
}).listen(port, "127.0.0.1", () => {
  console.log(`OP3 mapper API listening on http://127.0.0.1:${port}`);
});

async function handleRequest(request: IncomingMessage, response: ServerResponse) {
  setCors(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/songs") {
    const gameDir = url.searchParams.get("gameDir");
    if (!gameDir) throw new Error("Missing gameDir.");
    sendJson(response, 200, { songs: listSongs(resolve(gameDir)) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/install-project") {
    const body = await readJsonBody<{ gameDir?: string; projectPath?: string; serverDir?: string; syncServer?: boolean; uniqueXsb?: boolean }>(request);
    if (!body.gameDir) throw new Error("Missing gameDir.");
    if (!body.projectPath) throw new Error("Missing projectPath.");
    const gameDir = resolve(body.gameDir);
    const result = await runCli(["install-project", gameDir, resolve(body.projectPath), ...(body.uniqueXsb ? ["--unique-xsb"] : [])]);
    if (body.syncServer && body.serverDir) syncServerMusicList(gameDir, resolve(body.serverDir));
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/install-current-project") {
    const body = await readJsonBody<{
      gameDir?: string;
      project?: Op3SongProject;
      audioFileName?: string;
      audioBase64?: string;
      jacketFileName?: string;
      jacketBase64?: string;
      serverDir?: string;
      syncServer?: boolean;
      uniqueXsb?: boolean;
    }>(request);
    if (!body.gameDir) throw new Error("Missing gameDir.");
    if (!body.project) throw new Error("Missing project.");

    const gameDir = resolve(body.gameDir);
    const projectPath = writeUploadProject(body.project, body.audioFileName, body.audioBase64, body.jacketFileName, body.jacketBase64);
    const result = await runCli(["install-project", gameDir, projectPath, ...(body.uniqueXsb ? ["--unique-xsb"] : [])]);
    if (body.syncServer && body.serverDir) syncServerMusicList(gameDir, resolve(body.serverDir));
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/generate-project") {
    const body = await readJsonBody<{
      project?: Op3SongProject;
      audioFileName?: string;
      audioBase64?: string;
      midiFileName?: string;
      midiBase64?: string;
      options?: { density?: number; sensitivity?: number; trills?: boolean };
    }>(request);
    if (!body.project) throw new Error("Missing project.");
    if (!body.audioFileName || !body.audioBase64) throw new Error("Missing audio.");
    const project = generateProjectFromUpload(body.project, body.audioFileName, body.audioBase64, body.options ?? {}, body.midiFileName, body.midiBase64);
    sendJson(response, 200, { project });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/remove-song") {
    const body = await readJsonBody<{ gameDir?: string; basename?: string; serverDir?: string; syncServer?: boolean }>(request);
    if (!body.gameDir) throw new Error("Missing gameDir.");
    if (!body.basename) throw new Error("Missing basename.");
    const gameDir = resolve(body.gameDir);
    removeSongFromGame(gameDir, body.basename);
    if (body.syncServer && body.serverDir) syncServerMusicList(gameDir, resolve(body.serverDir));
    sendJson(response, 200, { stdout: `Removed ${body.basename}` });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sync-server-music-list") {
    const body = await readJsonBody<{ gameDir?: string; serverDir?: string }>(request);
    if (!body.gameDir) throw new Error("Missing gameDir.");
    if (!body.serverDir) throw new Error("Missing serverDir.");
    const outputPath = syncServerMusicList(resolve(body.gameDir), resolve(body.serverDir));
    sendJson(response, 200, { stdout: `Synced server music list: ${outputPath}` });
    return;
  }

  if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
    serveStatic(url.pathname, response);
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

function listSongs(gameDir: string): SongListItem[] {
  const musicListPath = join(gameDir, "data_op3", "sound", "music_list.xml");
  const musicRoot = join(gameDir, "data_op3", "sound", "music");
  if (!existsSync(musicListPath) || !existsSync(musicRoot)) {
    throw new Error(`Game directory does not look like an OP3 folder: ${gameDir}`);
  }

  const text = readFileSync(musicListPath, "latin1");
  const songs: SongListItem[] = [];
  for (const match of text.matchAll(/<music_spec __type='void' index='(\d+)'>([\s\S]*?)<\/music_spec>/g)) {
    const body = match[2];
    const basename = readXmlField(body, "basename");
    if (!basename) continue;
    songs.push({
      index: Number(match[1]),
      basename,
      title: readXmlField(body, "title") || basename,
      artist: readXmlField(body, "artist") || "",
      levels: [
        Number(readXmlField(body, "level_normal") || 0),
        Number(readXmlField(body, "level_hard") || 0),
        Number(readXmlField(body, "level_extreme") || 0),
        Number(readXmlField(body, "level_real") || 0)
      ],
      installed: existsSync(join(musicRoot, basename.toLowerCase())),
      custom: basename.toUpperCase().startsWith("M_CUSTOM")
    });
  }

  return songs.sort((a, b) => b.index - a.index);
}

function removeSongFromGame(gameDir: string, basename: string) {
  if (!basename.toUpperCase().startsWith("M_CUSTOM")) {
    throw new Error("Only M_CUSTOM songs can be removed from the Web UI patcher.");
  }

  const musicListPath = join(gameDir, "data_op3", "sound", "music_list.xml");
  const musicRoot = join(gameDir, "data_op3", "sound", "music");
  if (!existsSync(musicListPath) || !existsSync(musicRoot)) {
    throw new Error(`Game directory does not look like an OP3 folder: ${gameDir}`);
  }

  const original = readFileSync(musicListPath);
  const text = original.toString("latin1");
  const escaped = escapeRegExp(basename);
  const pattern = new RegExp(`\\s*<music_spec __type='void' index='\\d+'>\\r?\\n(?:(?!\\s*</music_spec>).)*?<basename\\s+__type='str' >${escaped}</basename>(?:(?!\\s*</music_spec>).)*?\\s*</music_spec>\\r?\\n?`, "s");
  const match = text.match(pattern);
  if (!match || match.index === undefined) {
    throw new Error(`${basename} is not registered.`);
  }

  backupOnce(musicListPath);
  const start = Buffer.byteLength(text.slice(0, match.index), "latin1");
  const end = start + Buffer.byteLength(match[0], "latin1");
  writeFileSync(musicListPath, Buffer.concat([original.subarray(0, start), original.subarray(end)]));

  const folder = join(musicRoot, basename.toLowerCase());
  if (existsSync(folder)) {
    rmSync(folder, { recursive: true, force: true });
  }
}

function syncServerMusicList(gameDir: string, serverDir: string): string {
  const source = join(gameDir, "data_op3", "sound", "music_list.xml");
  const destination = join(serverDir, "modules", "nostalgia", "music_list.xml");
  if (!existsSync(source)) {
    throw new Error(`Game music_list.xml was not found: ${source}`);
  }
  if (!existsSync(join(serverDir, "modules", "nostalgia"))) {
    throw new Error(`Server directory does not look like MonkeyBusiness: ${serverDir}`);
  }

  backupOnce(destination);
  copyFileSync(source, destination);
  return destination;
}

function writeUploadProject(project: Op3SongProject, audioFileName?: string, audioBase64?: string, jacketFileName?: string, jacketBase64?: string): string {
  const uploadDir = join(mapperRoot, "scratch", "web-installs", `${Date.now()}-${sanitizeFilename(project.id)}`);
  mkdirSync(uploadDir, { recursive: true });

  const patchedProject: Op3SongProject = { ...project };
  if (audioFileName && audioBase64) {
    const safeAudioName = sanitizeFilename(audioFileName);
    writeFileSync(join(uploadDir, safeAudioName), Buffer.from(audioBase64, "base64"));
    patchedProject.audioPath = safeAudioName;
  }
  if (jacketFileName && jacketBase64) {
    const safeJacketName = sanitizeFilename(jacketFileName);
    writeFileSync(join(uploadDir, safeJacketName), Buffer.from(jacketBase64, "base64"));
    patchedProject.jacketPath = safeJacketName;
  } else if (patchedProject.jacketPath && existsSync(patchedProject.jacketPath)) {
    const sourceName = sanitizeFilename(basename(patchedProject.jacketPath));
    copyFileSync(patchedProject.jacketPath, join(uploadDir, sourceName));
    patchedProject.jacketPath = sourceName;
  }

  const projectPath = join(uploadDir, `${sanitizeFilename(project.id.toLowerCase())}.op3song.json`);
  writeFileSync(projectPath, `${JSON.stringify(patchedProject, null, 2)}\n`, "utf8");
  return projectPath;
}

function generateProjectFromUpload(project: Op3SongProject, audioFileName: string, audioBase64: string, options: { density?: number; sensitivity?: number; trills?: boolean }, midiFileName?: string, midiBase64?: string): Op3SongProject {
  const workDir = join(mapperRoot, "scratch", "web-generates", `${Date.now()}-${sanitizeFilename(project.id)}`);
  mkdirSync(workDir, { recursive: true });
  const audioPath = join(workDir, sanitizeFilename(audioFileName));
  const midiPath = midiFileName && midiBase64 ? join(workDir, sanitizeFilename(midiFileName)) : undefined;
  const inputPath = join(workDir, "input.json");
  const outputPath = join(workDir, "output.op3song.json");
  writeFileSync(audioPath, Buffer.from(audioBase64, "base64"));
  if (midiPath && midiBase64) writeFileSync(midiPath, Buffer.from(midiBase64, "base64"));
  writeFileSync(inputPath, JSON.stringify({ project, audioPath, midiPath, options }, null, 2), "utf8");

  const result = spawnSync("python", [
    pythonGeneratorPath,
    "--input", inputPath,
    "--output", outputPath,
    "--ffmpeg", ffmpegPath
  ], {
    cwd: mapperRoot,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16
  });

  if (result.status !== 0) {
    throw new Error(`Python generator failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim());
  }
  return JSON.parse(readFileSync(outputPath, "utf8")) as Op3SongProject;
}

function sanitizeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_. -]/g, "_").slice(0, 120) || "project";
}

function readXmlField(body: string, field: string): string {
  const match = body.match(new RegExp(`<${field}\\s+__type='[^']+'\\s*>([^<]*)</${field}>`));
  return unescapeXml(match?.[1]?.trim() ?? "");
}

function unescapeXml(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function backupOnce(path: string) {
  const backup = `${path}.op3-mapper.bak`;
  if (existsSync(path) && !existsSync(backup)) {
    writeFileSync(backup, readFileSync(path));
  }
}

function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: mapperRoot,
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      };
      if (code === 0) resolvePromise(result);
      else rejectPromise(new Error(`${result.stdout}\n${result.stderr}`.trim() || `CLI failed with code ${code}`));
    });
  });
}

function serveStatic(pathname: string, response: ServerResponse) {
  const root = join(mapperRoot, "ui-dist");
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = resolve(root, requested);
  if (!filePath.startsWith(root) || !existsSync(filePath)) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  const type = extname(filePath) === ".js"
    ? "text/javascript"
    : extname(filePath) === ".css"
      ? "text/css"
      : extname(filePath) === ".html"
        ? "text/html"
        : "application/octet-stream";
  response.writeHead(200, { "Content-Type": type });
  response.end(readFileSync(filePath));
}

function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("error", rejectPromise);
    request.on("end", () => {
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T);
      } catch (error) {
        rejectPromise(error);
      }
    });
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  setCors(response);
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function setCors(response: ServerResponse) {
  response.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:5173");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
