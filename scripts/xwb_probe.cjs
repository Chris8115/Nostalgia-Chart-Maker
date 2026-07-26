const fs = require("fs");

function u32(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function readCString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length);
  const zero = slice.indexOf(0);
  return slice.subarray(0, zero >= 0 ? zero : slice.length).toString("ascii");
}

function decodeMini(value) {
  const tag = value & 0x3;
  const channels = (value >> 2) & 0x7;
  const sampleRate = (value >> 5) & 0x3ffff;
  const blockAlignField = (value >> 23) & 0xff;
  const bitsField = (value >> 31) & 0x1;
  const tagNames = ["PCM", "XMA", "ADPCM", "WMA"];
  let bitsPerSample = bitsField ? 16 : 8;
  let blockAlign = blockAlignField;
  let avgBytesPerSec = sampleRate * blockAlign;
  let samplesPerBlock = 0;

  if (tag === 1 || tag === 3) {
    bitsPerSample = 16;
  } else if (tag === 2) {
    bitsPerSample = 4;
    blockAlign = (blockAlignField + 22) * channels;
    samplesPerBlock = blockAlign * 2 / channels - 12;
    avgBytesPerSec = Math.floor(blockAlign * sampleRate / samplesPerBlock);
  }

  return { value: `0x${value.toString(16).padStart(8, "0")}`, tag, tagName: tagNames[tag] ?? "?", channels, sampleRate, blockAlignField, blockAlign, bitsPerSample, samplesPerBlock, avgBytesPerSec };
}

for (const path of process.argv.slice(2)) {
  const b = fs.readFileSync(path);
  const segments = [];
  for (let i = 0; i < 5; i++) {
    const base = 12 + i * 8;
    segments.push({ offset: u32(b, base), length: u32(b, base + 4) });
  }

  const bankOffset = segments[0].offset;
  const bank = {
    flags: u32(b, bankOffset),
    entryCount: u32(b, bankOffset + 4),
    name: readCString(b, bankOffset + 8, 64),
    entryMetaSize: u32(b, bankOffset + 72),
    entryNameSize: u32(b, bankOffset + 76),
    alignment: u32(b, bankOffset + 80),
    compactFormat: decodeMini(u32(b, bankOffset + 84))
  };

  const entryOffset = segments[1].offset;
  const flagsAndDuration = u32(b, entryOffset);
  const entry = {
    flags: flagsAndDuration & 0xf,
    durationSamples: flagsAndDuration >>> 4,
    format: decodeMini(u32(b, entryOffset + 4)),
    playOffset: u32(b, entryOffset + 8),
    playLength: u32(b, entryOffset + 12),
    loopStartSample: u32(b, entryOffset + 16),
    loopTotalSamples: u32(b, entryOffset + 20)
  };

  console.log(JSON.stringify({
    path,
    signature: b.subarray(0, 4).toString("ascii"),
    version: u32(b, 4),
    headerVersion: u32(b, 8),
    segments,
    bank,
    entry
  }, null, 2));
}
