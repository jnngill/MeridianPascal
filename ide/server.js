#!/usr/bin/env node
// MERIDIAN Pascal IDE - local server (no dependencies)
//   node ide/server.js [--port 8165] [--workspace <dir>]
// Serves the IDE on http://127.0.0.1:<port>, the compiler and emulator
// modules, the libraries, and a small file API for the project folder.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPascalCart } from '../compiler/mkcart.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = +argOf('--port', process.env.MP_PORT || 8165);
const WORKSPACE = path.resolve(argOf('--workspace', process.env.MP_WORKSPACE || path.join(ROOT, 'projects')));
const CONFIG_FILE = path.join(ROOT, 'ide', 'config.json');

const DEFAULT_CONFIG = {
  misterHost: '',
  meridianRoot: fs.existsSync(path.join(ROOT, '..', 'MERIDIAN_SCHUB_MiSTer')) ? path.join(ROOT, '..', 'MERIDIAN_SCHUB_MiSTer') : '',
  python: process.platform === 'win32' ? 'py' : 'python3',
  target: 'm816',
  fontSize: 14,
};
function loadConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
  catch { return { ...DEFAULT_CONFIG }; }
}
function saveConfig(c) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2)); }

// first start: copy the examples into the workspace
if (!fs.existsSync(WORKSPACE)) {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  const ex = path.join(ROOT, 'examples');
  if (fs.existsSync(ex)) {
    for (const f of fs.readdirSync(ex)) if (/\.pas$/i.test(f)) fs.copyFileSync(path.join(ex, f), path.join(WORKSPACE, f));
  }
  fs.mkdirSync(path.join(WORKSPACE, 'disk'), { recursive: true });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.pas': 'text/plain; charset=utf-8', '.bin': 'application/octet-stream',
  '.mer': 'application/octet-stream', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8',
};
const STATIC = [
  ['/compiler/', path.join(ROOT, 'compiler')],
  ['/emu/', path.join(ROOT, 'emu')],
  ['/lib/', path.join(ROOT, 'lib')],
  ['/docs/', path.join(ROOT, 'docs')],
  ['/', path.join(ROOT, 'ide', 'public')],
];

// resolve a workspace-relative path safely
function wsPath(rel) {
  const p = path.resolve(WORKSPACE, rel || '.');
  if (p !== WORKSPACE && !p.startsWith(WORKSPACE + path.sep)) throw Object.assign(new Error('path outside the workspace'), { code: 403 });
  return p;
}

function listTree(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out.push({ name: e.name, path: rel, dir: true, children: listTree(path.join(dir, e.name), rel) });
    else {
      const st = fs.statSync(path.join(dir, e.name));
      out.push({ name: e.name, path: rel, size: st.size, mtime: st.mtimeMs });
    }
  }
  return out;
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, code, body, type = 'application/json') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

async function api(req, res, url) {
  const q = url.searchParams;
  const route = url.pathname.slice(4);
  const m = req.method;
  if (route === '/info' && m === 'GET') {
    return send(res, 200, { workspace: WORKSPACE, root: ROOT, version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'))).version });
  }
  if (route === '/config') {
    if (m === 'GET') return send(res, 200, loadConfig());
    if (m === 'PUT') {
      const c = { ...loadConfig(), ...JSON.parse((await readBody(req)).toString('utf8')) };
      saveConfig(c);
      return send(res, 200, c);
    }
  }
  if (route === '/files' && m === 'GET') return send(res, 200, listTree(WORKSPACE));
  if (route === '/file') {
    const p = wsPath(q.get('path'));
    if (m === 'GET') {
      if (!fs.existsSync(p)) return send(res, 404, { error: 'not found' });
      return send(res, 200, fs.readFileSync(p), q.get('raw') ? 'application/octet-stream' : 'text/plain; charset=latin1');
    }
    if (m === 'PUT') {
      const body = await readBody(req);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
      return send(res, 200, { ok: true, size: body.length });
    }
    if (m === 'DELETE') {
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true });
      return send(res, 200, { ok: true });
    }
  }
  if (route === '/mkdir' && m === 'POST') {
    fs.mkdirSync(wsPath(q.get('path')), { recursive: true });
    return send(res, 200, { ok: true });
  }
  if (route === '/rename' && m === 'POST') {
    const from = wsPath(q.get('from')), to = wsPath(q.get('to'));
    if (fs.existsSync(to)) return send(res, 409, { error: 'a file with that name exists' });
    fs.renameSync(from, to);
    return send(res, 200, { ok: true });
  }
  // all units visible to a program: the libraries plus .pas files next to it
  if (route === '/units' && m === 'GET') {
    const out = {};
    const add = (dir, prefix) => {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir)) {
        if (!/\.(pas|pp|inc)$/i.test(f)) continue;
        const name = f.replace(/\.(pas|pp)$/i, '').toLowerCase();
        const text = fs.readFileSync(path.join(dir, f), 'latin1');
        // a program file must not hide a library unit of the same name
        if (prefix !== 'lib/' && out[name] && /^\s*(\{[^}]*\}\s*|\/\/[^\n]*\n\s*)*program\b/i.test(text)) continue;
        out[/\.inc$/i.test(f) ? f.toLowerCase() : name] = { text, path: prefix + f };
      }
    };
    add(path.join(ROOT, 'lib'), 'lib/');
    const d = q.get('dir');
    add(d ? wsPath(d) : WORKSPACE, (d ? d + '/' : ''));
    return send(res, 200, out);
  }
  if (route === '/libs' && m === 'GET') {
    const dir = path.join(ROOT, 'lib');
    return send(res, 200, fs.readdirSync(dir).filter(f => f.endsWith('.pas')).map(f => ({ name: f.replace(/\.pas$/, ''), path: 'lib/' + f })));
  }
  if (route === '/examples' && m === 'GET') {
    const dir = path.join(ROOT, 'examples');
    return send(res, 200, fs.readdirSync(dir).filter(f => f.endsWith('.pas')).map(f => {
      const t = fs.readFileSync(path.join(dir, f), 'latin1');
      const d = /\{\s*([^}]*)\}/.exec(t);
      return { name: f, title: d ? d[1].split('\n')[0].trim() : f };
    }));
  }
  if (route === '/example' && m === 'POST') {
    const name = path.basename(q.get('name'));
    const src = path.join(ROOT, 'examples', name);
    let dst = wsPath(name);
    if (fs.existsSync(dst)) {
      let i = 2;
      while (fs.existsSync(wsPath(name.replace(/\.pas$/, `_${i}.pas`)))) i++;
      dst = wsPath(name.replace(/\.pas$/, `_${i}.pas`));
    }
    fs.copyFileSync(src, dst);
    return send(res, 200, { ok: true, path: path.relative(WORKSPACE, dst).split(path.sep).join('/') });
  }
  // build the PASCAL cartridge (on-device IDE + compiler), save it in the workspace
  if (route === '/cart' && m === 'POST') {
    const r = buildPascalCart();
    if (!r.ok) return send(res, 500, { error: r.errors.map(e => `${e.file ? path.basename(e.file) : ''}${e.line ? `(${e.line})` : ''} ${e.msg}`).join(' / ') });
    fs.writeFileSync(path.join(WORKSPACE, 'PASCAL.MOD'), r.bytes);
    return send(res, 200, Buffer.from(r.bytes), 'application/octet-stream');
  }
  // send a .MER to the MiSTer with tools/senden.py (ssh, user root)
  if (route === '/send' && m === 'POST') {
    const cfg = loadConfig();
    const host = q.get('host') || cfg.misterHost;
    if (!host) return send(res, 400, { error: 'Set the MiSTer address in Settings first.' });
    if (!/^[A-Za-z0-9_.:@-]+$/.test(host)) return send(res, 400, { error: 'invalid host name' });
    const tool = path.join(cfg.meridianRoot || '', 'tools', 'senden.py');
    if (!fs.existsSync(tool)) return send(res, 400, { error: `tools/senden.py not found under "${cfg.meridianRoot}". Set the MERIDIAN repository folder in Settings.` });
    const p = wsPath(q.get('path'));
    if (!fs.existsSync(p)) return send(res, 404, { error: 'build the program first' });
    const argv = [tool, host, p];
    const py = cfg.python || 'python3';
    const child = spawn(py, py === 'py' ? ['-3', ...argv] : argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { child.kill(); out += '\n(timeout after 60 s - does ssh need a password? Use an ssh key.)'; }, 60000);
    child.on('error', (e) => { clearTimeout(timer); send(res, 500, { error: `cannot start ${py}: ${e.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); if (!res.headersSent) send(res, 200, { ok: code === 0, code, output: out }); });
    return;
  }
  send(res, 404, { error: 'unknown api' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    for (const [prefix, dir] of STATIC) {
      if (!url.pathname.startsWith(prefix)) continue;
      let rel = decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html';
      const p = path.resolve(dir, rel);
      if (!p.startsWith(dir)) return send(res, 403, 'forbidden', 'text/plain');
      if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) continue;
      return send(res, 200, fs.readFileSync(p), MIME[path.extname(p).toLowerCase()] || 'application/octet-stream');
    }
    send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    send(res, e.code === 403 ? 403 : 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`MERIDIAN Pascal IDE: http://127.0.0.1:${PORT}/`);
  console.log(`workspace: ${WORKSPACE}`);
});
