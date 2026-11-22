// MERIDIAN Pascal - 65C816 assembler
// Accepts the subset of 64tass syntax that the code generator and the
// runtime use, so the output can be checked against 64tass byte for byte.
// Multi-pass: label addresses and operand sizes are iterated until stable;
// out-of-range branches are relaxed to "b!cc *+5 / jmp target" (BRA -> BRL).

const G1 = { ora: 0x00, and: 0x20, eor: 0x40, adc: 0x60, sta: 0x80, lda: 0xa0, cmp: 0xc0, sbc: 0xe0 };
const G1OFF = { imm: 0x09, dp: 0x05, dpx: 0x15, abs: 0x0d, absx: 0x1d, absy: 0x19, long: 0x0f,
  longx: 0x1f, ind: 0x12, indx: 0x01, indy: 0x11, indl: 0x07, indly: 0x17, sr: 0x03, sry: 0x13 };

const OPS = {};
for (const [m, b] of Object.entries(G1)) {
  OPS[m] = {};
  for (const [mode, o] of Object.entries(G1OFF)) {
    if (m === 'sta' && mode === 'imm') continue;
    OPS[m][mode] = b + o;
  }
  if (m !== 'sta') OPS[m].immM = true;
}
const add = (m, modes) => { OPS[m] = Object.assign(OPS[m] || {}, modes); };
add('asl', { acc: 0x0a, dp: 0x06, dpx: 0x16, abs: 0x0e, absx: 0x1e });
add('lsr', { acc: 0x4a, dp: 0x46, dpx: 0x56, abs: 0x4e, absx: 0x5e });
add('rol', { acc: 0x2a, dp: 0x26, dpx: 0x36, abs: 0x2e, absx: 0x3e });
add('ror', { acc: 0x6a, dp: 0x66, dpx: 0x76, abs: 0x6e, absx: 0x7e });
add('dec', { acc: 0x3a, dp: 0xc6, dpx: 0xd6, abs: 0xce, absx: 0xde });
add('inc', { acc: 0x1a, dp: 0xe6, dpx: 0xf6, abs: 0xee, absx: 0xfe });
add('bit', { imm: 0x89, dp: 0x24, dpx: 0x34, abs: 0x2c, absx: 0x3c, immM: true });
add('cpx', { imm: 0xe0, dp: 0xe4, abs: 0xec, immX: true });
add('cpy', { imm: 0xc0, dp: 0xc4, abs: 0xcc, immX: true });
add('ldx', { imm: 0xa2, dp: 0xa6, dpy: 0xb6, abs: 0xae, absy: 0xbe, immX: true });
add('ldy', { imm: 0xa0, dp: 0xa4, dpx: 0xb4, abs: 0xac, absx: 0xbc, immX: true });
add('stx', { dp: 0x86, dpy: 0x96, abs: 0x8e });
add('sty', { dp: 0x84, dpx: 0x94, abs: 0x8c });
add('stz', { dp: 0x64, dpx: 0x74, abs: 0x9c, absx: 0x9e });
add('trb', { dp: 0x14, abs: 0x1c });
add('tsb', { dp: 0x04, abs: 0x0c });
add('jmp', { abs: 0x4c, long: 0x5c, absind: 0x6c, absindx: 0x7c, absindl: 0xdc });
add('jml', { long: 0x5c, absindl: 0xdc });
add('jsr', { abs: 0x20, absindx: 0xfc, long: 0x22 });
add('jsl', { long: 0x22 });
add('pea', { abs: 0xf4 });
add('pei', { ind: 0xd4 });
add('rep', { imm: 0xc2, imm8: true });
add('sep', { imm: 0xe2, imm8: true });
add('cop', { imm: 0x02, imm8: true });
add('brk', { imm: 0x00, imm8: true, imp: 0x00 });
const BR = { bpl: 0x10, bmi: 0x30, bvc: 0x50, bvs: 0x70, bcc: 0x90, bcs: 0xb0, bne: 0xd0, beq: 0xf0, bra: 0x80 };
const BRINV = { bpl: 'bmi', bmi: 'bpl', bvc: 'bvs', bvs: 'bvc', bcc: 'bcs', bcs: 'bcc', bne: 'beq', beq: 'bne' };
BR.blt = BR.bcc; BR.bge = BR.bcs;
const IMP = { clc: 0x18, cld: 0xd8, cli: 0x58, clv: 0xb8, sec: 0x38, sed: 0xf8, sei: 0x78,
  dex: 0xca, dey: 0x88, inx: 0xe8, iny: 0xc8, nop: 0xea, pha: 0x48, phb: 0x8b, phd: 0x0b,
  phk: 0x4b, php: 0x08, phx: 0xda, phy: 0x5a, pla: 0x68, plb: 0xab, pld: 0x2b, plp: 0x28,
  plx: 0xfa, ply: 0x7a, rti: 0x40, rtl: 0x6b, rts: 0x60, stp: 0xdb, tax: 0xaa, tay: 0xa8,
  tcd: 0x5b, tcs: 0x1b, tdc: 0x7b, tsc: 0x3b, tsx: 0xba, txa: 0x8a, txs: 0x9a, txy: 0x9b,
  tya: 0x98, tyx: 0xbb, wai: 0xcb, wdm: 0x42, xba: 0xeb, xce: 0xfb };

export class AsmError extends Error {
  constructor(msg, line, src) { super(msg); this.line = line; this.src = src; }
}

// ---- expressions: numbers, symbols, * (pc), + - * / & | ^ << >>, unary - < > ^ (bank), ()
export function evalExpr(str, syms, pc, undefinedOk) {
  let i = 0;
  const s = str;
  let undef = false;
  const ws = () => { while (s[i] === ' ' || s[i] === '\t') i++; };
  function prim() {
    ws();
    const c = s[i];
    if (c === '(') { i++; const v = expr(); ws(); if (s[i] !== ')') throw new Error('missing )'); i++; return v; }
    if (c === '-') { i++; return -prim(); }
    if (c === '<') { i++; return prim() & 0xff; }
    if (c === '>') { i++; return (prim() >> 8) & 0xff; }
    if (c === '`' || c === '^') { i++; return (prim() >> 16) & 0xff; }
    if (c === '~') { i++; return ~prim(); }
    if (c === '$') { const m = /^\$[0-9a-fA-F]+/.exec(s.slice(i)); i += m[0].length; return parseInt(m[0].slice(1), 16); }
    if (c === '%') { const m = /^%[01]+/.exec(s.slice(i)); i += m[0].length; return parseInt(m[0].slice(1), 2); }
    if (c === '*') { i++; return pc; }
    if (c === "'" || c === '"') { const v = s.charCodeAt(i + 1); i += 3; return v; }
    let m = /^0[xX][0-9a-fA-F]+/.exec(s.slice(i));
    if (m) { i += m[0].length; return parseInt(m[0].slice(2), 16); }
    m = /^[0-9]+/.exec(s.slice(i));
    if (m) { i += m[0].length; return parseInt(m[0], 10); }
    m = /^[A-Za-z_.][A-Za-z0-9_.]*/.exec(s.slice(i));
    if (m) {
      i += m[0].length;
      const v = syms.get(m[0]);
      if (v === undefined) { if (undefinedOk) { undef = true; return 0; } throw new Error(`undefined symbol '${m[0]}'`); }
      return v;
    }
    throw new Error(`bad expression '${s}'`);
  }
  function mul() {
    let v = prim();
    for (;;) {
      ws();
      if (s[i] === '*') { i++; v = v * prim(); }
      else if (s[i] === '/') { i++; v = Math.trunc(v / prim()); }
      else if (s.startsWith('<<', i)) { i += 2; v = v << prim(); }
      else if (s.startsWith('>>', i)) { i += 2; v = v >> prim(); }
      else return v;
    }
  }
  function sum() {
    let v = mul();
    for (;;) {
      ws();
      if (s[i] === '+') { i++; v = v + mul(); }
      else if (s[i] === '-') { i++; v = v - mul(); }
      else return v;
    }
  }
  function expr() {
    let v = sum();
    for (;;) {
      ws();
      if (s[i] === '&') { i++; v = v & sum(); }
      else if (s[i] === '|') { i++; v = v | sum(); }
      else return v;
    }
  }
  const v = expr();
  ws();
  if (i < s.length) throw new Error(`bad expression '${s}'`);
  return { v, undef };
}

export function splitArgs(s) {
  const out = [];
  let depth = 0, cur = '', q = null;
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"') { q = c; continue; }
    if (c === "'" && line[i + 2] === "'") { i += 2; continue; }
    if (c === ';') return line.slice(0, i);
  }
  return line;
}

// parse operand syntax -> {mode, expr, size}
function parseOperand(op) {
  op = op.trim();
  let size = null;
  const pm = /^@([bwl])\s*/.exec(op);
  if (pm) { size = pm[1]; op = op.slice(pm[0].length); }
  if (op === '' ) return { mode: 'imp' };
  if (op.toLowerCase() === 'a') return { mode: 'acc' };
  if (op[0] === '#') return { mode: 'imm', e: op.slice(1), size };
  let m;
  if ((m = /^\((.*),\s*[sS]\s*\)\s*,\s*[yY]$/.exec(op))) return { mode: 'sry', e: m[1], size };
  if ((m = /^\((.*),\s*[xX]\s*\)$/.exec(op))) return { mode: 'indx', e: m[1], size };
  if ((m = /^\((.*)\)\s*,\s*[yY]$/.exec(op))) return { mode: 'indy', e: m[1], size };
  if ((m = /^\[(.*)\]\s*,\s*[yY]$/.exec(op))) return { mode: 'indly', e: m[1], size };
  if ((m = /^\[(.*)\]$/.exec(op))) return { mode: 'indl', e: m[1], size };
  if ((m = /^\((.*)\)$/.exec(op)) && balanced(m[1])) return { mode: 'ind', e: m[1], size };
  if ((m = /^(.*),\s*[xX]$/.exec(op))) return { mode: 'x', e: m[1], size };
  if ((m = /^(.*),\s*[yY]$/.exec(op))) return { mode: 'y', e: m[1], size };
  if ((m = /^(.*),\s*[sS]$/.exec(op))) return { mode: 'sr', e: m[1], size };
  return { mode: 'addr', e: op, size };
}
function balanced(s) {
  let d = 0;
  for (const c of s) { if (c === '(') d++; if (c === ')') { d--; if (d < 0) return false; } }
  return d === 0;
}

export function assemble816(text, opts = {}) {
  const lines = text.split(/\r?\n/);
  const parsed = [];
  lines.forEach((raw, idx) => {
    const line = stripComment(raw).replace(/\s+$/, '');
    if (!line.trim()) { parsed.push({ idx, raw, kind: 'none' }); return; }
    let m;
    if ((m = /^([A-Za-z_.][A-Za-z0-9_.]*)\s*=\s*(.+)$/.exec(line.trim()))) {
      parsed.push({ idx, raw, kind: 'equ', name: m[1], e: m[2] });
      return;
    }
    let label = null, rest = line, anon = null;
    if (/^[+-](\s|$)/.test(line)) {
      anon = line[0];
      rest = line.slice(1);
    } else if (/^[A-Za-z_.]/.test(line)) {
      m = /^([A-Za-z_.][A-Za-z0-9_.]*):?/.exec(line);
      label = m[1];
      rest = line.slice(m[0].length);
    }
    rest = rest.trim();
    if (!rest) { parsed.push({ idx, raw, kind: 'label', label, anon }); return; }
    if (rest.startsWith('*')) {
      const mm = /^\*\s*=\s*(.+)$/.exec(rest);
      if (!mm) throw new AsmError('bad origin', idx + 1, raw);
      parsed.push({ idx, raw, kind: 'org', label, e: mm[1] });
      return;
    }
    const sp = /^(\S+)\s*(.*)$/.exec(rest);
    const mn = sp[1].toLowerCase();
    parsed.push({ idx, raw, kind: mn.startsWith('.') ? 'dir' : 'ins', label, mn, arg: sp[2], anon });
  });

  // anonymous labels (64tass): a line label '+' or '-', referenced as + / -
  {
    let n = 0;
    const minus = [];   // names in order
    const plusAt = [];  // [lineIndex, name]
    parsed.forEach((L, k) => {
      if (L.anon) {
        L.label = `__anon${++n}`;
        if (L.anon === '-') minus.push([k, L.label]); else plusAt.push([k, L.label]);
      }
    });
    parsed.forEach((L, k) => {
      if ((L.kind !== 'ins') || !/^[+-]+$/.test((L.arg || '').trim())) return;
      const ref = L.arg.trim();
      const cnt = ref.length;
      if (ref[0] === '-') {
        const prev = minus.filter(([j]) => j <= k);
        L.arg = prev[prev.length - cnt][1];
      } else {
        const nxt = plusAt.filter(([j]) => j > k);
        L.arg = nxt[cnt - 1][1];
      }
    });
  }

  const syms = new Map(Object.entries(opts.symbols || {}));
  const sizes = new Map();     // instruction index -> byte size guess
  const relaxed = new Set();   // branches that need the long form
  const blockSize = new Map(); // .bankfit line -> size of its block (last pass)
  let out, listing, pc, origin;

  for (let pass = 0; pass < 12; pass++) {
    let changed = false;
    const final = pass > 0;
    out = []; listing = []; origin = null;
    pc = opts.org || 0;
    let mWide = true, xWide = true;
    let inLogical = false, bankStart = null;
    const setSym = (name, v) => {
      if (syms.get(name) !== v) { changed = true; syms.set(name, v); }
    };
    const ev = (e) => {
      try { return evalExpr(e, syms, pc, pass === 0); }
      catch (err) { throw new AsmError(err.message, curLine.idx + 1, curLine.raw); }
    };
    let curLine;
    for (let li = 0; li < parsed.length; li++) {
      const L = curLine = parsed[li];
      if (L.kind === 'none') continue;
      if (L.kind === 'equ') { const r = ev(L.e); setSym(L.name, r.v); continue; }
      if (L.label) setSym(L.label, pc);
      if (L.kind === 'label') continue;
      if (L.kind === 'org') {
        const r = ev(L.e);
        pc = r.v;
        if (origin === null) origin = pc;
        else if (pc < origin + out.length) throw new AsmError('origin moves backwards', L.idx + 1, L.raw);
        else while (origin + out.length < pc) out.push(0);
        continue;
      }
      const start = pc;
      const bytes = [];
      const emit8 = (v) => bytes.push(v & 0xff);
      if (L.kind === 'dir') {
        const args = splitArgs(L.arg);
        switch (L.mn) {
          case '.cpu': case '.include': break;
          case '.logical': inLogical = true; pc = ev(args[0]).v; break;
          case '.here': inLogical = false; pc = origin + out.length; break;
          case '.bankfit': {
            // the block up to the next .bankfit must not cross a 64 KB bank
            if (bankStart !== null) {
              const n = pc - bankStart.pc;
              if (blockSize.get(bankStart.li) !== n) { blockSize.set(bankStart.li, n); changed = true; }
            }
            const need = blockSize.get(li) || 0;
            if ((pc & 0xffff) + need > 0x10000) while ((pc + bytes.length) & 0xffff) emit8(0);
            bankStart = { li, pc: pc + bytes.length };
            break;
          }
          case '.al': mWide = true; break;
          case '.as': mWide = false; break;
          case '.xl': xWide = true; break;
          case '.xs': xWide = false; break;
          case '.byte': for (const a of args) emit8(ev(a).v); break;
          case '.word': for (const a of args) { const v = ev(a).v; emit8(v); emit8(v >> 8); } break;
          case '.long': for (const a of args) { const v = ev(a).v; emit8(v); emit8(v >> 8); emit8(v >> 16); } break;
          case '.dword': for (const a of args) { const v = ev(a).v; emit8(v); emit8(v >> 8); emit8(v >> 16); emit8(v >> 24); } break;
          case '.text': for (const a of args) {
            if (a[0] === '"') { for (const ch of a.slice(1, -1)) emit8(ch.charCodeAt(0)); }
            else emit8(ev(a).v);
          } break;
          case '.fill': { const n = ev(args[0]).v; const v = args[1] ? ev(args[1]).v : 0; for (let k = 0; k < n; k++) emit8(v); break; }
          case '.align': { const n = ev(args[0]).v; while ((pc + bytes.length) % n) emit8(0); break; }
          default: throw new AsmError(`unknown directive ${L.mn}`, L.idx + 1, L.raw);
        }
      } else {
        const mn = L.mn;
        if (IMP[mn] !== undefined && !L.arg.trim()) {
          emit8(IMP[mn]);
        } else if (BR[mn] !== undefined) {
          const t = ev(L.arg).v;
          const long = relaxed.has(li);
          if (!long) {
            const d = t - (pc + 2);
            if (final && (d < -128 || d > 127)) { relaxed.add(li); changed = true; }
            emit8(BR[mn]); emit8(d);
          } else if (mn === 'bra') {
            const d = t - (pc + 3);
            emit8(0x82); emit8(d); emit8(d >> 8);
          } else {
            emit8(BR[BRINV[mn] || mn]); emit8(3);
            const d = t - (pc + 5);
            emit8(0x82); emit8(d); emit8(d >> 8);      // BRL, like 64tass --long-branch
          }
        } else if (mn === 'brl' || mn === 'per') {
          const t = ev(L.arg).v;
          const d = t - (pc + 3);
          emit8(mn === 'brl' ? 0x82 : 0x62); emit8(d); emit8(d >> 8);
        } else if (mn === 'mvn' || mn === 'mvp') {
          const a = splitArgs(L.arg).map(x => ev(x.replace(/^#/, '')).v);
          emit8(mn === 'mvn' ? 0x54 : 0x44); emit8(a[1]); emit8(a[0]);
        } else {
          const tab = OPS[mn];
          if (!tab) throw new AsmError(`unknown instruction '${mn}'`, L.idx + 1, L.raw);
          const o = parseOperand(L.arg);
          let mode = o.mode, val = 0, undef = false;
          if (o.e !== undefined) { const r = ev(o.e); val = r.v; undef = r.undef; }
          const isJmp = mn === 'jmp' || mn === 'jsr' || mn === 'jml' || mn === 'jsl';
          let opc, nb;
          const pick = (cands) => {
            for (const [md, n] of cands) if (tab[md] !== undefined) return [md, n];
            return null;
          };
          let sel = null;
          if (mode === 'imp') { if (tab.imp !== undefined) sel = ['imp', 0]; else if (tab.acc !== undefined) sel = ['acc', 0]; }
          else if (mode === 'acc') sel = ['acc', 0];
          else if (mode === 'imm') {
            let n = tab.imm8 ? 1 : tab.immX ? (xWide ? 2 : 1) : (mWide ? 2 : 1);
            if (o.size === 'b') n = 1; if (o.size === 'w') n = 2;
            sel = ['imm', n];
          } else if (mode === 'addr' || mode === 'x' || mode === 'y') {
            const suf = mode === 'addr' ? '' : mode;
            let want = o.size;
            if (!want) {
              if (isJmp) want = val > 0xffff ? 'l' : 'w';
              else if (undef) want = 'w';
              else if (val > 0xffff) want = 'l';
              else if (val >= 0 && val <= 0xff && !sizes.has(li)) want = 'b';
              else want = 'w';
              if (undef) sizes.set(li, 'w');   // forward reference: never direct page
            }
            const dpM = 'dp' + suf, absM = 'abs' + suf, longM = 'long' + suf;
            if (mn === 'pea') sel = ['abs', 2];
            else if (want === 'b') sel = pick([[dpM, 1], [absM, 2], [longM, 3]]);
            else if (want === 'w') sel = pick([[absM, 2], [longM, 3]]);
            else sel = pick([[longM, 3]]);
          } else if (mode === 'ind') {
            if (isJmp) sel = ['absind', 2];
            else sel = pick([['ind', 1]]);
          } else if (mode === 'indx') {
            if (isJmp) sel = ['absindx', 2]; else sel = pick([['indx', 1]]);
          } else if (mode === 'indl') {
            if (isJmp) sel = ['absindl', 2]; else sel = pick([['indl', 1]]);
          } else sel = pick([[mode, 1]]);
          if (!sel || tab[sel[0]] === undefined) throw new AsmError(`addressing mode not available for ${mn}`, L.idx + 1, L.raw);
          [mode, nb] = sel;
          opc = tab[mode];
          emit8(opc);
          for (let k = 0; k < nb; k++) emit8(val >> (8 * k));
        }
      }
      if (origin === null && bytes.length) origin = start;
      for (const b of bytes) out.push(b);
      pc += bytes.length;
      if (opts.listing) listing.push({ addr: start, bytes, src: L.raw, line: L.idx + 1 });
    }
    if (bankStart !== null) {
      const n = pc - bankStart.pc;
      if (blockSize.get(bankStart.li) !== n) { blockSize.set(bankStart.li, n); changed = true; }
    }
    if (!changed && pass > 0) break;
    if (pass === 11) throw new AsmError('assembler did not converge', 0, '');
  }
  return { bytes: Uint8Array.from(out), origin: origin || 0, symbols: syms, listing };
}

export function formatListing(listing) {
  const hex = (v, n) => v.toString(16).padStart(n, '0');
  return listing.map(l => {
    const b = l.bytes.slice(0, 4).map(x => hex(x, 2)).join(' ') + (l.bytes.length > 4 ? '..' : '');
    return `${l.bytes.length || l.src.trim() ? hex(l.addr, 6) : '      '}  ${b.padEnd(13)} ${l.src}`;
  }).join('\n');
}
