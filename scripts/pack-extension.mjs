// Ships the browser bridge extension next to the web build so the preview
// (and any static host) can offer it as a download: load the unzipped folder
// at chrome://extensions → Developer mode → Load unpacked.
import { existsSync, mkdirSync, readdirSync, statSync, createWriteStream, readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const src = join(root, "extension");
const outDir = join(root, "dist");

if (!existsSync(src) || !existsSync(outDir)) process.exit(0);

// Minimal zip writer (no dep): stored entries + central directory.
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
})(src);

const chunks = [];
const central = [];
let offset = 0;
for (const file of files) {
  const rel = `noctbeat-bridge/${relative(src, file)}`;
  const name = Buffer.from(rel, "utf8");
  const data = readFileSync(file);
  const crc = crc32(data);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(0x0800, 6); // UTF-8 names
  head.writeUInt16LE(8, 8); // deflate
  head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(data.length, 18);
  head.writeUInt32LE(data.length, 22);
  head.writeUInt16LE(name.length, 26);
  const deflated = deflateSync(data);
  head.writeUInt32LE(deflated.length, 18);
  chunks.push(head, name, deflated);
  central.push({ name, crc, csize: deflated.length, usize: data.length, offset });
  offset += head.length + name.length + deflated.length;
}

const cdStart = offset;
const cdChunks = [];
for (const e of central) {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(20, 6);
  h.writeUInt16LE(0x0800, 8);
  h.writeUInt16LE(8, 10);
  h.writeUInt32LE(e.crc, 16);
  h.writeUInt32LE(e.csize, 20);
  h.writeUInt32LE(e.usize, 24);
  h.writeUInt16LE(e.name.length, 28);
  h.writeUInt32LE(e.offset, 42);
  cdChunks.push(h, e.name);
  offset += h.length + e.name.length;
}
const cdSize = offset - cdStart;
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(central.length, 8);
end.writeUInt16LE(central.length, 10);
end.writeUInt32LE(cdSize, 12);
end.writeUInt32LE(cdStart, 16);

mkdirSync(outDir, { recursive: true });
createWriteStream(join(outDir, "noctbeat-bridge.zip")).end(
  Buffer.concat([...chunks, ...cdChunks, end]),
);
console.log(`pack-extension: dist/noctbeat-bridge.zip (${files.length} files)`);

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
