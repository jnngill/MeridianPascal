// MERIDIAN Pascal IDE - main
import { Editor } from './editor.js';
import { EmuView } from './emuview.js';
import { compile, TARGETS } from '/compiler/compile.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hex = (v, n = 6) => '$' + (v >>> 0).toString(16).toUpperCase().padStart(n, '0');

// ------------------------------------------------------------------ state
const state = {
  tabs: [],          // {path, name, text, saved, readOnly, lib, sel, scroll}
  active: -1,
  config: {},
  target: 'm816',
  lastBuild: null,
  tree: [],
};

const editor = new Editor($('#editor'), {
  onChange: () => {
    const t = curTab();
    if (!t || t.readOnly) return;
    t.text = editor.value;
    renderTabs();
  },
  onCursor: (p) => { $('#sbPos').textContent = `Ln ${p.line}, Col ${p.col}`; },
});

const emu = new EmuView($('#screen'), {
  onStatus: (s) => {
    const el = $('#emuState');
    el.textContent = s.state === 'running' ? `running ${s.fps ? s.fps + ' fps' : ''}` : s.state;
    el.className = 'pill ' + s.state;
    let info = `cycles ${s.cycles.toLocaleString()}`;
    if (s.schub) info += ' · SCHUB running';
    if (s.schubError) info += ` · SCHUB: ${s.schubError}`;
    if (s.message && s.state !== 'running') info += ` · ${s.message}`;
    $('#emuInfo').textContent = info;
    if (s.state !== 'running') $('#p-out').textContent = emu.output();
  },
  onFileSaved: async (drive, name, data) => {
    await fetch(`/api/file?path=${encodeURIComponent('disk/' + name)}`, { method: 'PUT', body: data });
    msg(`program saved ${name} (${data.length} bytes) on drive ${drive}`, 'info');
    refreshDisk();
  },
});

// ------------------------------------------------------------------ api
async function api(path, opts) {
  const r = await fetch(path, opts);
  const ct = r.headers.get('content-type') || '';
  const body = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(body && body.error ? body.error : `${r.status} ${r.statusText}`);
  return body;
}
const getText = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`cannot read ${url}`); return decodeLatin1(new Uint8Array(await r.arrayBuffer())); };
function decodeLatin1(u8) { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return s; }
function encodeLatin1(s) { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); u[i] = c < 256 ? c : 63; } return u; }

// ------------------------------------------------------------------ messages
function msg(text, kind = 'info', onclick) {
  const d = document.createElement('div');
  d.className = 'msg ' + kind;
  d.textContent = text;
  if (onclick) d.addEventListener('click', onclick);
  $('#p-msgs').appendChild(d);
  $('#p-msgs').scrollTop = 1e9;
  return d;
}
function clearMsgs() { $('#p-msgs').innerHTML = ''; }
function showPane(p) {
  for (const b of document.querySelectorAll('#btabs [data-p]')) b.classList.toggle('on', b.dataset.p === p);
  for (const d of document.querySelectorAll('.bpane')) d.classList.toggle('on', d.id === 'p-' + p);
}

// ------------------------------------------------------------------ tabs
const curTab = () => state.tabs[state.active];
function saveEditorState() {
  const t = curTab();
  if (t) { t.text = editor.value; t.sel = [editor.ta.selectionStart, editor.ta.selectionEnd]; t.scroll = editor.ta.scrollTop; }
}
function activate(i) {
  if (i !== state.active) saveEditorState();
  state.active = i;
  const t = curTab();
  $('#welcome').classList.toggle('hidden', !!t);
  if (t) {
    editor.setValue(t.text);
    editor.readOnly = !!t.readOnly;
    if (t.sel) editor.ta.setSelectionRange(t.sel[0], t.sel[1]);
    if (t.scroll) { editor.ta.scrollTop = t.scroll; editor.syncScroll(); }
    editor.setErrors(t.errors || []);
    $('#sbFile').textContent = (t.lib ? 'library ' : '') + t.path + (t.readOnly ? ' (read-only)' : '');
    editor.focus();
  } else $('#sbFile').textContent = '';
  renderTabs();
  renderTree();
}
function renderTabs() {
  const el = $('#tabs');
  el.innerHTML = '';
  state.tabs.forEach((t, i) => {
    const d = document.createElement('div');
    d.className = 'tab' + (i === state.active ? ' on' : '');
    d.innerHTML = `<span>${esc(t.name)}</span>${t.readOnly ? '<span class="ro">RO</span>' : ''}${!t.readOnly && t.text !== t.saved ? '<span class="dirty">&#9679;</span>' : ''}<span class="close" title="Close">&times;</span>`;
    d.addEventListener('click', (e) => { if (e.target.classList.contains('close')) closeTab(i); else activate(i); });
    d.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(i); });
    el.appendChild(d);
  });
}
async function closeTab(i) {
  const t = state.tabs[i];
  if (!t.readOnly && t.text !== t.saved) {
    const r = await ask('Unsaved changes', `Save changes to ${t.name}?`, null, ['Save', 'Discard']);
    if (r === null) return;
    if (r === 'Save') await saveTab(t);
  }
  state.tabs.splice(i, 1);
  if (state.active >= state.tabs.length) state.active = state.tabs.length - 1;
  else if (i < state.active) state.active--;
  activate(state.active);
}
async function openFile(path, opts = {}) {
  let i = state.tabs.findIndex(t => t.path === path);
  if (i < 0) {
    const lib = path.startsWith('lib/');
    const text = lib ? await getText('/' + path) : await getText(`/api/file?path=${encodeURIComponent(path)}`);
    state.tabs.push({ path, name: path.split('/').pop(), text, saved: text, readOnly: lib, lib });
    i = state.tabs.length - 1;
  }
  activate(i);
  if (opts.line) editor.goTo(opts.line, opts.col || 1);
  return curTab();
}
async function saveTab(t) {
  if (!t || t.readOnly) return;
  if (t === curTab()) t.text = editor.value;
  await fetch(`/api/file?path=${encodeURIComponent(t.path)}`, { method: 'PUT', body: encodeLatin1(t.text) });
  t.saved = t.text;
  renderTabs();
}
async function saveAll() { for (const t of state.tabs) if (!t.readOnly && t.text !== t.saved) await saveTab(t); }

// ------------------------------------------------------------------ file tree
async function refreshTree() {
  state.tree = await api('/api/files');
  renderTree();
  refreshDiskList();
}
function renderTree() {
  const el = $('#tree');
  el.innerHTML = '';
  const cur = curTab();
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      if (n.dir && n.name === 'disk' && depth === 0) continue;
      const d = document.createElement('div');
      d.className = 'item' + (cur && cur.path === n.path ? ' active' : '') + (/\.mer$/i.test(n.name) ? ' mer' : '');
      d.style.setProperty('--d', depth);
      const ic = n.dir ? (n.open === false ? '&#9656;' : '&#9662;') : /\.pas$/i.test(n.name) ? 'P' : /\.mer$/i.test(n.name) ? 'M' : '&middot;';
      d.innerHTML = `<span class="ic">${ic}</span><span class="nm">${esc(n.name)}</span>${n.dir ? '' : `<span class="sz">${fmtSize(n.size)}</span>`}<span class="x" title="Rename / delete">&#8943;</span>`;
      d.addEventListener('click', (e) => {
        if (e.target.classList.contains('x')) { fileMenu(n); return; }
        if (n.dir) { n.open = n.open === false; renderTree(); return; }
        if (/\.(pas|pp|inc|txt|md|asm)$/i.test(n.name)) openFile(n.path);
        else if (/\.mer$/i.test(n.name)) runMerFile(n.path);
      });
      el.appendChild(d);
      if (n.dir && n.open !== false) walk(n.children, depth + 1);
    }
  };
  walk(state.tree, 0);
}
const fmtSize = (n) => n < 1024 ? `${n}` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)}K`;

async function fileMenu(n) {
  const r = await ask(n.name, 'Rename or delete this ' + (n.dir ? 'folder' : 'file') + '.', n.path, ['Rename', 'Delete']);
  if (r === null) return;
  if (r === 'Delete') {
    const sure = await ask('Delete', `Delete ${n.path}? This cannot be undone.`, null, ['Delete']);
    if (sure !== 'Delete') return;
    await api(`/api/file?path=${encodeURIComponent(n.path)}`, { method: 'DELETE' });
    const i = state.tabs.findIndex(t => t.path === n.path);
    if (i >= 0) { state.tabs.splice(i, 1); state.active = Math.min(state.active, state.tabs.length - 1); activate(state.active); }
  } else {
    const to = $('#prInput').value.trim();
    if (to && to !== n.path) {
      await api(`/api/rename?from=${encodeURIComponent(n.path)}&to=${encodeURIComponent(to)}`, { method: 'POST' });
      for (const t of state.tabs) if (t.path === n.path) { t.path = to; t.name = to.split('/').pop(); }
      renderTabs();
    }
  }
  refreshTree();
}

async function newFile() {
  const r = await ask('New file', 'Name of the new file (in the project folder):', 'myprog.pas', ['Program', 'Unit']);
  if (r === null) return;
  let name = $('#prInput').value.trim();
  if (!name) return;
  if (!/\.\w+$/.test(name)) name += '.pas';
  const base = name.split('/').pop().replace(/\.pas$/i, '');
  const ident = base.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[0-9]/, '_$&');
  const text = r === 'Unit'
    ? `unit ${ident};\n\ninterface\n\nprocedure Hello;\n\nimplementation\n\nprocedure Hello;\nbegin\n  WriteLn('Hello from unit ${ident}');\nend;\n\nend.\n`
    : `program ${ident};\n\nuses Crt;\n\nbegin\n  ClrScr;\n  WriteLn('Hello, MERIDIAN!');\nend.\n`;
  if (state.tree.some(n => n.path === name)) { msg(`${name} already exists`, 'err'); return; }
  await fetch(`/api/file?path=${encodeURIComponent(name)}`, { method: 'PUT', body: encodeLatin1(text) });
  await refreshTree();
  openFile(name);
}
async function newDir() {
  const r = await ask('New folder', 'Folder name:', 'project', []);
  if (r === null) return;
  const n = $('#prInput').value.trim();
  if (n) { await api(`/api/mkdir?path=${encodeURIComponent(n)}`, { method: 'POST' }); refreshTree(); }
}

// ------------------------------------------------------------------ libraries / examples
async function loadSidebars() {
  const libs = await api('/api/libs');
  const el = $('#libs');
  el.innerHTML = '';
  for (const l of libs) {
    const d = document.createElement('div');
    d.className = 'item';
    d.innerHTML = `<span class="ic">U</span><span class="nm">${esc(l.name.charAt(0).toUpperCase() + l.name.slice(1))}</span>`;
    d.title = 'Open the unit source (read-only)';
    d.addEventListener('click', () => openFile(l.path));
    el.appendChild(d);
  }
  const ex = await api('/api/examples');
  const ee = $('#examples');
  ee.innerHTML = '';
  for (const x of ex) {
    const d = document.createElement('div');
    d.className = 'item ex';
    d.innerHTML = `<span class="ic">&#9733;</span><span class="nm">${esc(x.name)}<small>${esc(x.title)}</small></span>`;
    d.title = 'Copy into the project and open';
    d.addEventListener('click', async () => {
      const existing = state.tree.find(n => n.path === x.name);
      if (existing) { openFile(x.name); return; }
      const r = await api(`/api/example?name=${encodeURIComponent(x.name)}`, { method: 'POST' });
      await refreshTree();
      openFile(r.path);
    });
    ee.appendChild(d);
  }
}

// ------------------------------------------------------------------ build
function dirOf(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }

async function build({ quiet } = {}) {
  const t = curTab();
  if (!t) { msg('Open a program first.', 'warn'); return null; }
  if (t.lib) { msg('Library units are compiled as part of a program. Open a program to build.', 'warn'); return null; }
  saveEditorState();
  await saveAll();
  showPane('msgs');
  clearMsgs();
  for (const x of state.tabs) { x.errors = []; }
  editor.setErrors([]);
  const target = state.target;
  msg(`Building ${t.path} for ${TARGETS[target].title} ...`, 'info');
  const dir = dirOf(t.path);
  const units = await api(`/api/units${dir ? '?dir=' + encodeURIComponent(dir) : ''}`);
  for (const x of state.tabs) {
    if (!x.lib && /\.pas$/i.test(x.path) && dirOf(x.path) === dir) units[x.name.replace(/\.pas$/i, '').toLowerCase()] = { text: x.text, path: x.path };
  }
  const res = compile(t.text, t.path, {
    target,
    loadUnit: (name) => units[name] ? { text: units[name].text, name: units[name].path } : null,
    loadInclude: (fn) => { const u = units[fn.toLowerCase()]; return u ? { text: u.text, name: u.path } : null; },
  });
  state.lastBuild = { ...res, path: t.path };
  if (!res.ok) {
    for (const e of res.errors) {
      const where = e.file ? `${e.file}(${e.line},${e.col})` : t.path;
      msg(`${where}: error: ${e.msg}`, 'err', () => gotoError(e));
      if (e.stack) console.error(e.stack);
    }
    const e = res.errors[0];
    if (e && e.file) gotoError(e);
    return null;
  }
  const merPath = t.path.replace(/\.(pas|pp)$/i, '') + '.mer';
  await fetch(`/api/file?path=${encodeURIComponent(merPath)}`, { method: 'PUT', body: res.mer });
  res.merPath = merPath;
  msg(`OK  ${merPath}: ${res.bytes.length.toLocaleString()} bytes, load ${hex(res.load)}, start ${hex(res.start)}  ·  ${res.procCount.used} of ${res.procCount.total} routines used  ·  units: ${res.units.join(', ')}  ·  ${res.ms} ms`, 'ok');
  $('#p-asm').textContent = res.asm;
  $('#p-lst').textContent = res.listing;
  renderMap(res);
  refreshTree();
  return res;
}

function gotoError(e) {
  if (!e.file) return;
  const open = async () => {
    const tab = await openFile(e.file, { line: e.line, col: e.col });
    tab.errors = [{ line: e.line, msg: e.msg }];
    editor.setErrors(tab.errors);
  };
  open().catch(err => msg(err.message, 'err'));
}

function renderMap(res) {
  const i = res.info;
  const rows = [];
  const add = (k, v) => rows.push(`<tr><td>${k}</td><td>${v}</td></tr>`);
  if (res.target === 'm816') {
    add('Target', '65C816 native code, bank 0');
    add('Load / start', `${hex(res.load)} (JSL, returns with RTL to BASIC)`);
    add('Code + data', `${hex(i.codeStart)} - ${hex(i.imageEnd - 1)} (${(i.imageEnd - i.codeStart).toLocaleString()} bytes)`);
    add('Variables (bss)', `${hex(i.imageEnd)} - ${hex(i.heapStart - 1)}`);
    add('Heap', `${hex(i.heapStart)} upwards`);
    add('Stack', `${hex(i.stackTop)} downwards`);
    add('Free for heap + stack', `${(i.stackTop - i.heapStart).toLocaleString()} bytes`);
  } else {
    add('Target', 'SCHUB RV32IM (65C816 host stub + RISC-V program)');
    add('Load / start', `${hex(res.load)} (stub, JSL)`);
    add('RISC-V code', `${hex(i.codeStart)} - ${hex(i.imageEnd - 1)}`);
    add('Heap', `${hex(i.heapStart)} upwards`);
    add('Stack', `${hex(i.stackTop)} downwards`);
    add('Mailbox', '$0403F0 (uncached alias $800403F0)');
  }
  add('Routines', `${res.procCount.used} used of ${res.procCount.total} compiled`);
  add('Units', res.units.join(', '));
  let bar = '';
  if (res.target === 'm816') {
    const span = 0xc000 - 0x2000;
    const pct = (a) => ((a - 0x2000) / span * 100).toFixed(2) + '%';
    bar = `<div class="bar" title="bank 0 from $2000 to $C000">
      <div style="left:0;width:${pct(i.imageEnd)};background:#2f6fe0"></div>
      <div style="left:${pct(i.imageEnd)};width:${(((i.heapStart - i.imageEnd) / span) * 100).toFixed(2)}%;background:#3aa76d"></div>
      <div style="left:${pct(i.stackTop - 256)};width:${pct(0xc000 - (i.stackTop - 256) + 0x2000)};background:#b86b2a"></div>
      <div style="left:${pct(0xb800)};right:0;background:#55607a"></div></div>
      <div class="hint">blue: code and data &middot; green: variables &middot; orange: stack &middot; grey: BASIC extension ($B800)</div>`;
  }
  $('#p-map').innerHTML = `<div class="map"><table>${rows.join('')}</table>${bar}</div>`;
}

// ------------------------------------------------------------------ run / send
async function syncDisk() {
  const files = [];
  const disk = (state.tree.find(n => n.dir && n.name === 'disk') || { children: [] }).children.filter(n => !n.dir);
  for (const f of disk) {
    const r = await fetch(`/api/file?path=${encodeURIComponent(f.path)}&raw=1`);
    files.push([f.name, new Uint8Array(await r.arrayBuffer())]);
  }
  emu.setDriveFiles(1, files);
  emu.setDriveFiles(3, files);
}

async function run() {
  const res = await build();
  if (!res) return;
  await syncDisk();
  const info = emu.run(res.mer);
  $('#emuTarget').textContent = res.target === 'schub' ? '+ SCHUB' : '';
  msg(`Running in the emulator (start ${hex(info.start)}). Click the screen to type; Esc stops the program.`, 'info');
}
async function runMerFile(path) {
  const r = await fetch(`/api/file?path=${encodeURIComponent(path)}&raw=1`);
  const mer = new Uint8Array(await r.arrayBuffer());
  await syncDisk();
  try { emu.run(mer); msg(`Running ${path}`, 'info'); } catch (e) { msg(`${path}: ${e.message}`, 'err'); }
}
async function sendToMister() {
  const res = await build();
  if (!res) return;
  if (!state.config.misterHost) {
    msg('Set the MiSTer address in Settings first.', 'warn');
    openSettings();
    return;
  }
  msg(`Sending ${res.merPath} to ${state.config.misterHost} with tools/senden.py ...`, 'info');
  try {
    const r = await api(`/api/send?path=${encodeURIComponent(res.merPath)}`, { method: 'POST' });
    if (r.output) msg(r.output.trim(), r.ok ? 'info' : 'err');
    msg(r.ok ? 'Sent - the program starts on the MERIDIAN.' : `senden.py failed (exit ${r.code})`, r.ok ? 'ok' : 'err');
  } catch (e) { msg(e.message, 'err'); }
}

// the PASCAL cartridge: the IDE and compiler that run on the MERIDIAN itself
async function runCartridge() {
  showPane('msgs');
  msg('Building the PASCAL cartridge (on-device IDE and compiler) ...', 'info');
  try {
    const r = await fetch('/api/cart', { method: 'POST' });
    if (!r.ok) { msg((await r.json()).error || 'cartridge build failed', 'err'); return; }
    const mod = new Uint8Array(await r.arrayBuffer());
    await syncDisk();
    emu.runCartridge(mod);
    $('#emuTarget').textContent = '+ PASCAL.MOD';
    msg(`PASCAL.MOD (${mod.length.toLocaleString()} bytes) is running in the emulator. Click the screen: F1 help, F5 run, F2/F3 save/load on drive 1 (the project's disk/ folder). The cartridge was also saved as PASCAL.MOD in the project - copy it to /media/fat/games/MERIDIAN/ and choose it under "Insert cartridge".`, 'ok');
    refreshTree();
  } catch (e) { msg(e.message, 'err'); }
}

// ------------------------------------------------------------------ disk panel
async function refreshDisk() { state.tree = await api('/api/files'); refreshDiskList(); renderTree(); }
function refreshDiskList() {
  const el = $('#diskFiles');
  const disk = (state.tree.find(n => n.dir && n.name === 'disk') || { children: [] }).children.filter(n => !n.dir);
  el.innerHTML = disk.length ? '' : '<li class="empty">empty &mdash; programs using the Dos unit save here</li>';
  for (const f of disk) {
    const li = document.createElement('li');
    li.innerHTML = `<a href="/api/file?path=${encodeURIComponent(f.path)}&raw=1" download="${esc(f.name)}">${esc(f.name)}</a><span class="sz">${f.size.toLocaleString()} bytes</span>`;
    el.appendChild(li);
  }
}

// ------------------------------------------------------------------ dialogs
function ask(title, text, value, choices) {
  return new Promise((resolve) => {
    const dlg = $('#dlgPrompt');
    $('#prTitle').textContent = title;
    $('#prText').textContent = text;
    const inp = $('#prInput');
    inp.classList.toggle('hidden', value === null || value === undefined);
    inp.value = value || '';
    const ch = $('#prChoices');
    ch.innerHTML = '';
    const ok = $('#prOk');
    ok.classList.toggle('hidden', !!(choices && choices.length));
    let picked = null;
    for (const c of choices || []) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = c;
      b.className = 'accent';
      b.addEventListener('click', () => { picked = c; dlg.close('ok'); });
      ch.appendChild(b);
    }
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' ? (picked || 'ok') : null);
    dlg.showModal();
    if (!inp.classList.contains('hidden')) { inp.focus(); inp.select(); }
  });
}
async function openSettings() {
  const dlg = $('#dlgSettings');
  const f = dlg.querySelector('form');
  for (const k of ['misterHost', 'meridianRoot', 'python', 'fontSize']) f.elements[k].value = state.config[k] ?? '';
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') return;
    const c = {};
    for (const k of ['misterHost', 'meridianRoot', 'python']) c[k] = f.elements[k].value.trim();
    c.fontSize = +f.elements.fontSize.value || 14;
    state.config = await api('/api/config', { method: 'PUT', body: JSON.stringify(c) });
    applyConfig();
  };
  dlg.showModal();
}
function applyConfig() {
  document.documentElement.style.setProperty('--fs', (state.config.fontSize || 14) + 'px');
  editor.render();
}

// ------------------------------------------------------------------ find
function openFind() {
  $('#findbar').classList.remove('hidden');
  const sel = editor.ta.value.slice(editor.ta.selectionStart, editor.ta.selectionEnd);
  if (sel && !sel.includes('\n')) $('#findText').value = sel;
  $('#findText').focus();
  $('#findText').select();
}
function closeFind() { $('#findbar').classList.add('hidden'); editor.focus(); }
function findNext(back) { if (!editor.find($('#findText').value, undefined, back)) msg(`"${$('#findText').value}" not found`, 'warn'); }

// ------------------------------------------------------------------ wiring
function setTarget(t) {
  state.target = t;
  $('#target').value = t;
  $('#sbTarget').textContent = TARGETS[t].title;
}

function wire() {
  $('#bNew').onclick = newFile;
  $('#bNewFile').onclick = newFile;
  $('#bNewDir').onclick = newDir;
  $('#bRefresh').onclick = refreshTree;
  $('#bSave').onclick = () => saveTab(curTab());
  $('#bBuild').onclick = () => build();
  $('#bRun').onclick = run;
  $('#bStop').onclick = () => emu.stop();
  $('#bSend').onclick = sendToMister;
  $('#bSettings').onclick = openSettings;
  $('#bReset').onclick = () => { emu.reset(); $('#emuTarget').textContent = ''; };
  $('#bPause').onclick = () => emu.pause(!emu.paused);
  $('#bMute').onclick = () => { emu.audio.setMuted(!emu.audio.muted); $('#bMute').innerHTML = emu.audio.muted ? '&#128263;' : '&#128266;'; };
  $('#bShot').onclick = () => {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 480;
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = false;
    x.drawImage($('#screen'), 0, 0, 640, 480);
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png');
    a.download = 'meridian.png';
    a.click();
  };
  $('#bClearMsgs').onclick = clearMsgs;
  $('#bCart').onclick = runCartridge;
  $('#bDiskRefresh').onclick = refreshDisk;
  $('#diskUpload').onchange = async (e) => {
    for (const f of e.target.files) {
      const name = f.name.toUpperCase();
      await fetch(`/api/file?path=${encodeURIComponent('disk/' + name)}`, { method: 'PUT', body: await f.arrayBuffer() });
    }
    e.target.value = '';
    refreshDisk();
  };
  $('#target').onchange = async (e) => {
    setTarget(e.target.value);
    state.config = await api('/api/config', { method: 'PUT', body: JSON.stringify({ target: state.target }) });
  };
  for (const b of document.querySelectorAll('#btabs [data-p]')) b.onclick = () => showPane(b.dataset.p);
  $('#bFindNext').onclick = () => findNext(false);
  $('#bFindPrev').onclick = () => findNext(true);
  $('#bFindClose').onclick = closeFind;
  $('#bReplace').onclick = () => {
    const ft = $('#findText').value.toLowerCase();
    const sel = editor.ta.value.slice(editor.ta.selectionStart, editor.ta.selectionEnd).toLowerCase();
    if (ft && sel === ft) editor.replaceSel($('#replText').value);
    findNext(false);
  };
  $('#bReplaceAll').onclick = () => {
    const ft = $('#findText').value;
    if (!ft) return;
    const re = new RegExp(ft.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const v = editor.value;
    const n = (v.match(re) || []).length;
    if (!n) return;
    editor.replace(0, v.length, v.replace(re, $('#replText').value));
    msg(`replaced ${n} occurrence${n === 1 ? '' : 's'}`, 'info');
  };
  $('#findText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); findNext(e.shiftKey); }
    if (e.key === 'Escape') closeFind();
  });

  window.addEventListener('keydown', (e) => {
    if (document.activeElement === $('#screen')) return;   // keys go to the MERIDIAN
    const k = e.key;
    if (k === 'F9') { e.preventDefault(); build(); }
    else if (k === 'F5' && e.shiftKey) { e.preventDefault(); emu.stop(); }
    else if (k === 'F5') { e.preventDefault(); run(); }
    else if (k === 'F8') { e.preventDefault(); sendToMister(); }
    else if ((e.ctrlKey || e.metaKey) && (k === 's' || k === 'S')) { e.preventDefault(); saveTab(curTab()); }
    else if ((e.ctrlKey || e.metaKey) && (k === 'f' || k === 'F') && document.activeElement !== $('#screen')) { e.preventDefault(); openFind(); }
    else if ((e.ctrlKey || e.metaKey) && (k === 'g' || k === 'G') && document.activeElement !== $('#screen')) {
      e.preventDefault();
      ask('Go to line', 'Line number:', '', []).then(r => { const n = +$('#prInput').value; if (r && n) editor.goTo(n); });
    } else if (e.altKey && (k === 'n' || k === 'N')) { e.preventDefault(); newFile(); }
  });
  window.addEventListener('beforeunload', (e) => {
    saveEditorState();
    if (state.tabs.some(t => !t.readOnly && t.text !== t.saved)) { e.preventDefault(); e.returnValue = ''; }
  });
}

// ------------------------------------------------------------------ start
async function main() {
  wire();
  try {
    state.config = await api('/api/config');
    const info = await api('/api/info');
    $('#wsPath').textContent = info.workspace;
  } catch (e) {
    msg('The IDE server is not reachable: ' + e.message, 'err');
  }
  setTarget(state.config.target || 'm816');
  applyConfig();
  await emu.init();
  await refreshTree();
  await loadSidebars();
  // open the first program of the project
  const first = state.tree.find(n => !n.dir && /^hello\.pas$/i.test(n.name)) || state.tree.find(n => !n.dir && /\.pas$/i.test(n.name));
  if (first) await openFile(first.path);
  renderTabs();
  msg('MERIDIAN Pascal ready. F9 builds, F5 builds and runs in the emulator, F8 sends to the MiSTer.', 'info');
}
main();
