#!/usr/bin/env node
// The C disk: a MERIDIAN disk image (C.DSK) for the C cartridge (C.MOD,
// node compiler/mkcart.js --c). It holds the C headers (clib/include), the
// sources of the C library (clib/src, the library itself is in the
// cartridge) and the C examples. The cartridge's compiler reads <x.h> from
// the current drive, then from drives 1, 2 and 3: insert the disk in the
// OSD under Drive 1 or Drive 2.
//
// The image is FAT16 without a partition table, 512 entries in the root
// directory and 8.3 names, as the core's tools/disk.py makes them (and the
// MERIDIAN's HEADER formats them).
//   node compiler/mkcdisk.js [-o C.DSK] [--mb 8]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const SECTOR = 512;
const ROOT_ENTRIES = 512;

// the files of the C disk: [8.3 name, text]
export function cDiskFiles() {
  const out = [];
  const add = (dir, re) => {
    for (const f of fs.readdirSync(dir).filter(f => re.test(f)).sort()) {
      out.push([f.toUpperCase(), fs.readFileSync(path.join(dir, f))]);
    }
  };
  add(path.join(root, 'clib', 'include'), /\.h$/i);
  add(path.join(root, 'clib', 'src'), /\.c$/i);
  add(path.join(root, 'examples'), /\.c$/i);
  for (const [n] of out) if (!/^[A-Z0-9_]{1,8}(\.[A-Z0-9_]{1,3})?$/.test(n)) throw new Error(`not an 8.3 name: ${n}`);
  const seen = new Set();
  for (const [n] of out) { if (seen.has(n)) throw new Error(`twice on the C disk: ${n}`); seen.add(n); }
  return out;
}

const name83 = (n) => {
  const [b, e = ''] = n.toUpperCase().split('.');
  return Buffer.from(b.padEnd(8) + e.padEnd(3), 'latin1');
};

// a formatted image with the files in its root directory
export function makeDisk(files, { mb = 8, label = 'MERIDIAN C' } = {}) {
  const sectors = mb * 1024 * 1024 / SECTOR;
  const rootSec = ROOT_ENTRIES * 32 / SECTOR;
  let spc = 1, spf, clusters;
  for (;;) {
    spf = 1;
    for (;;) {
      clusters = Math.floor((sectors - 1 - rootSec - 2 * spf) / spc);
      const need = Math.ceil((clusters + 2) * 2 / SECTOR);
      if (need <= spf) break;
      spf = need;
    }
    if (clusters <= 65524) break;
    spc *= 2;
  }
  if (clusters < 4085) throw new Error('too small for FAT16 (3 MB at least)');
  const d = Buffer.alloc(sectors * SECTOR);
  // the boot sector
  d.set([0xeb, 0x3c, 0x90], 0);
  d.write('MERIDIAN', 3, 'latin1');
  d.writeUInt16LE(SECTOR, 11); d[13] = spc; d.writeUInt16LE(1, 14); d[16] = 2;
  d.writeUInt16LE(ROOT_ENTRIES, 17); d.writeUInt16LE(sectors < 65536 ? sectors : 0, 19);
  d[21] = 0xf8; d.writeUInt16LE(spf, 22); d.writeUInt16LE(32, 24); d.writeUInt16LE(64, 26);
  d.writeUInt32LE(0, 28); d.writeUInt32LE(sectors >= 65536 ? sectors : 0, 32);
  d[36] = 0x80; d[38] = 0x29; d.writeUInt32LE(0x4d43, 39);
  d.write(label.toUpperCase().slice(0, 11).padEnd(11), 43, 'latin1');
  d.write('FAT16   ', 54, 'latin1');
  d[510] = 0x55; d[511] = 0xaa;
  const fatAt = (i) => (1 + i * spf) * SECTOR;
  const rootAt = (1 + 2 * spf) * SECTOR;
  const dataSec = 1 + 2 * spf + rootSec;
  const setFat = (c, v) => { for (let i = 0; i < 2; i++) d.writeUInt16LE(v, fatAt(i) + 2 * c); };
  setFat(0, 0xfff8); setFat(1, 0xffff);
  // the volume label, then the files
  d.write(label.toUpperCase().slice(0, 11).padEnd(11), rootAt, 'latin1');
  d[rootAt + 11] = 0x08;
  const csize = spc * SECTOR;
  let next = 2, entry = 1;
  // 26 November 2026, 12:00
  const time = 12 << 11, date = ((2026 - 1980) << 9) | (11 << 5) | 26;
  for (const [n, data] of files) {
    if (entry >= ROOT_ENTRIES) throw new Error('the root directory is full');
    const need = Math.max(1, Math.ceil(data.length / csize));
    if (next + need > clusters + 2) throw new Error('the disk is full');
    const first = data.length ? next : 0;
    for (let k = 0; k < need && data.length; k++) {
      setFat(next + k, k + 1 < need ? next + k + 1 : 0xffff);
      Buffer.from(data.subarray(k * csize, (k + 1) * csize)).copy(d, (dataSec + (next + k - 2) * spc) * SECTOR);
    }
    if (data.length) next += need;
    const e = rootAt + 32 * entry++;
    name83(n).copy(d, e);
    d[e + 11] = 0x20;
    d.writeUInt16LE(time, e + 22); d.writeUInt16LE(date, e + 24);
    d.writeUInt16LE(first, e + 26); d.writeUInt32LE(data.length, e + 28);
  }
  return d;
}

// the files of an image (the tests put them on an emulated drive)
export function readDisk(d) {
  const spc = d[13], res = d.readUInt16LE(14), nfat = d[16], nroot = d.readUInt16LE(17), spf = d.readUInt16LE(22);
  const rootAt = (res + nfat * spf) * SECTOR;
  const dataSec = res + nfat * spf + nroot * 32 / SECTOR;
  const files = new Map();
  for (let i = 0; i < nroot; i++) {
    const e = rootAt + 32 * i;
    if (d[e] === 0) break;
    if (d[e] === 0xe5 || (d[e + 11] & 0x18)) continue;
    const b = d.toString('latin1', e, e + 8).trimEnd(), x = d.toString('latin1', e + 8, e + 11).trimEnd();
    const size = d.readUInt32LE(e + 28);
    const out = Buffer.alloc(size);
    let c = d.readUInt16LE(e + 26), at = 0;
    while (c >= 2 && c < 0xfff8 && at < size) {
      d.copy(out, at, (dataSec + (c - 2) * spc) * SECTOR, (dataSec + (c - 1) * spc) * SECTOR);
      at += spc * SECTOR;
      c = d.readUInt16LE(res * SECTOR + 2 * c);
    }
    files.set(x ? `${b}.${x}` : b, new Uint8Array(out));
  }
  return files;
}

export function buildCDisk(opts = {}) {
  return makeDisk(cDiskFiles(), opts);
}

if (process.argv[1] && process.argv[1].endsWith('mkcdisk.js')) {
  const args = process.argv.slice(2);
  const oi = args.indexOf('-o');
  const out = oi >= 0 ? args[oi + 1] : path.join(root, 'C.DSK');
  const mi = args.indexOf('--mb');
  const files = cDiskFiles();
  fs.writeFileSync(out, makeDisk(files, { mb: mi >= 0 ? +args[mi + 1] : 8 }));
  console.log(`${out}: ${files.length} files (${files.map(f => f[0]).join(' ')})`);
}
