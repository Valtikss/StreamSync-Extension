import { cp, mkdir, rm, copyFile, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');

const SHARED_ASSETS = [
  'content.js',
  'service-worker.js',
  'popup.html',
  'popup.js',
  'overlay.css',
  'icon.svg',
  'spotify-logo.svg',
  'i18n',
  'icons',
];

const TARGETS = {
  chrome:  { manifest: 'manifest.chrome.json'  },
  firefox: { manifest: 'manifest.firefox.json' },
};

async function buildTarget(name) {
  const { manifest } = TARGETS[name];
  const out = join(DIST, name);

  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  for (const asset of SHARED_ASSETS) {
    const src = join(ROOT, asset);
    if (!existsSync(src)) {
      console.warn(`  [warn] missing asset: ${asset}`);
      continue;
    }
    await cp(src, join(out, asset), { recursive: true });
  }

  await copyFile(join(ROOT, manifest), join(out, 'manifest.json'));

  const pkg = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  console.log(`  ✓ ${name}: ${pkg.name} v${pkg.version} → dist/${name}/`);
  return pkg;
}

// ─── Pure-Node ZIP writer (deflate, no deps) ─────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1F);
  const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
  return { time, date };
}

async function walkDir(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await walkDir(full, base));
    } else {
      out.push({ rel: relative(base, full).split('\\').join('/'), abs: full });
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

async function createZip(srcDir, zipPath) {
  const files = await walkDir(srcDir);
  const { time, date } = dosDateTime();
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const f of files) {
    const data = await readFile(f.abs);
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const nameBuf = Buffer.from(f.rel, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localChunks.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  await writeFile(zipPath, Buffer.concat([...localChunks, centralBuf, eocd]));
  return { count: files.length, bytes: statSync(zipPath).size };
}

async function packTarget(name, version) {
  const src = join(DIST, name);
  const zip = join(DIST, `streamsync-${name}-${version}.zip`);
  await rm(zip, { force: true });
  const { count, bytes } = await createZip(src, zip);
  const kb = (bytes / 1024).toFixed(1);
  console.log(`  ✓ ${name}: ${count} files → dist/streamsync-${name}-${version}.zip (${kb} KB)`);
}

// ─── Source zip pour soumission AMO (reviewers Mozilla) ──────────────────────
// Inclut tout ce qui est nécessaire pour reproduire le build, exclut dist/,
// node_modules/, .git/. Forward-slashes garantis (createZip les normalise).
async function packSource(version) {
  const SOURCE_FILES = [
    ...SHARED_ASSETS,
    'manifest.chrome.json',
    'manifest.firefox.json',
    'build.mjs',
    'package.json',
    'README.md',
    'README.fr.md',
    '.gitignore',
  ];
  const stage = join(DIST, `_source-stage-${version}`);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  for (const f of SOURCE_FILES) {
    const src = join(ROOT, f);
    if (!existsSync(src)) continue;
    await cp(src, join(stage, f), { recursive: true });
  }
  const zip = join(DIST, `streamsync-source-${version}.zip`);
  await rm(zip, { force: true });
  const { count, bytes } = await createZip(stage, zip);
  await rm(stage, { recursive: true, force: true });
  const kb = (bytes / 1024).toFixed(1);
  console.log(`  ✓ source: ${count} files → dist/streamsync-source-${version}.zip (${kb} KB)`);
}

async function main() {
  const arg = process.argv[2];

  if (arg === 'source') {
    const pkgJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
    const version = pkgJson.version.split('.').slice(0, 2).join('.');
    console.log('Packing source zip for AMO submission');
    await mkdir(DIST, { recursive: true });
    await packSource(version);
    console.log('Done.');
    return;
  }

  const mode = arg === 'pack' ? 'pack' : 'build';
  const targetArg = mode === 'pack' ? process.argv[3] : arg;
  const targets = targetArg && targetArg !== 'all' ? [targetArg] : Object.keys(TARGETS);

  for (const t of targets) {
    if (!TARGETS[t]) {
      console.error(`Unknown target: ${t}. Use one of: ${Object.keys(TARGETS).join(', ')}, all`);
      process.exit(1);
    }
  }

  console.log(`Building: ${targets.join(', ')}`);
  const versions = {};
  for (const t of targets) {
    const pkg = await buildTarget(t);
    versions[t] = pkg.version;
  }

  if (mode === 'pack') {
    console.log(`Packing: ${targets.join(', ')}`);
    for (const t of targets) await packTarget(t, versions[t]);
  }

  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
