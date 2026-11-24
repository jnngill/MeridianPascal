// MERIDIAN Pascal - lexer
// Turns source text into tokens. Handles comments, compiler directives
// ({$IFDEF}, {$DEFINE}, {$I file}), Turbo Pascal number and string syntax.

import { decimalToReal } from './types.js';

export class CompileError extends Error {
  constructor(msg, pos) {
    super(msg);
    this.pos = pos || null;
  }
}

export const KEYWORDS = new Set([
  'and', 'array', 'asm', 'begin', 'case', 'const', 'div', 'do', 'downto', 'else',
  'end', 'file', 'for', 'function', 'goto', 'if', 'implementation', 'in',
  'interface', 'label', 'mod', 'nil', 'not', 'of', 'or', 'packed', 'procedure',
  'program', 'record', 'repeat', 'set', 'shl', 'shr', 'string', 'then', 'to',
  'type', 'unit', 'until', 'uses', 'var', 'while', 'with', 'xor',
  'initialization', 'finalization',
]);

// Two-character operators first
const OPS2 = [':=', '<=', '>=', '<>', '..', '(.', '.)', '+=', '-='];
const OPS1 = '+-*/=<>()[].,;:^@';

export function tokenize(text, file, defines, includeLoader) {
  const toks = [];
  const condStack = []; // {active, taken}
  const isActive = () => condStack.every(c => c.active);
  // switches ({$R+} range checks, {$Q+} overflow checks, {$I-} I/O checks):
  // every token's pos carries the ones in force where it stands
  let sw = { R: false, Q: false, I: true };

  function lex(src, fname) {
    let i = 0, line = 1, col = 1;
    const n = src.length;
    const pos = () => ({ file: fname, line, col, sw });
    const adv = (k = 1) => {
      for (let j = 0; j < k; j++) {
        if (src[i] === '\n') { line++; col = 1; } else col++;
        i++;
      }
    };

    function directive(body, p) {
      if (/^\$[A-Za-z][+-](\s*,\s*[A-Za-z][+-])*\s*$/.test(body)) {
        if (!isActive()) return;
        sw = { ...sw };
        for (const [, l, v] of body.matchAll(/([A-Za-z])([+-])/g)) sw[l.toUpperCase()] = v === '+';
        return;
      }
      const m = /^\$([A-Za-z]+)\s*(.*)$/s.exec(body);
      if (!m) return;
      const name = m[1].toUpperCase();
      const arg = m[2].trim();
      const word = arg.split(/\s+/)[0].toUpperCase();
      switch (name) {
        case 'IFDEF': condStack.push({ active: defines.has(word), taken: defines.has(word) }); return;
        case 'IFNDEF': condStack.push({ active: !defines.has(word), taken: !defines.has(word) }); return;
        case 'ELSE': {
          const c = condStack[condStack.length - 1];
          if (!c) throw new CompileError('$ELSE without $IFDEF', p);
          c.active = !c.taken; c.taken = true; return;
        }
        case 'ENDIF': case 'IFEND':
          if (!condStack.length) throw new CompileError('$ENDIF without $IFDEF', p);
          condStack.pop(); return;
      }
      if (!isActive()) return;
      switch (name) {
        case 'DEFINE': defines.add(word); return;
        case 'UNDEF': defines.delete(word); return;
        case 'I': case 'INCLUDE': {
          if (!includeLoader) throw new CompileError('include not supported here', p);
          const fn = arg.replace(/^'|'$/g, '');
          const inc = includeLoader(fn, fname);
          if (inc == null) throw new CompileError(`include file not found: ${fn}`, p);
          lex(inc.text, inc.name);
          return;
        }
        default:
          // other switches ($R+, $B-, ...) are accepted and ignored
          return;
      }
    }

    while (i < n) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f') { adv(); continue; }
      const p = pos();
      // comments
      if (c === '{') {
        const e = src.indexOf('}', i + 1);
        if (e < 0) throw new CompileError('unterminated comment', p);
        const body = src.slice(i + 1, e);
        adv(e - i + 1);
        if (body.startsWith('$')) directive(body, p);
        continue;
      }
      if (c === '(' && src[i + 1] === '*') {
        const e = src.indexOf('*)', i + 2);
        if (e < 0) throw new CompileError('unterminated comment', p);
        const body = src.slice(i + 2, e);
        adv(e - i + 2);
        if (body.startsWith('$')) directive(body, p);
        continue;
      }
      if (c === '/' && src[i + 1] === '/') {
        while (i < n && src[i] !== '\n') adv();
        continue;
      }
      if (!isActive()) { adv(); continue; }

      // identifiers / keywords
      if (/[A-Za-z_]/.test(c)) {
        let j = i;
        while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
        const word = src.slice(i, j);
        const lw = word.toLowerCase();
        adv(j - i);
        if (KEYWORDS.has(lw)) toks.push({ k: 'kw', v: lw, pos: p });
        else toks.push({ k: 'id', v: lw, raw: word, pos: p });
        continue;
      }
      // numbers
      if (/[0-9]/.test(c) || (c === '$' && /[0-9A-Fa-f]/.test(src[i + 1] || '')) ||
          (c === '%' && /[01]/.test(src[i + 1] || ''))) {
        let j = i;
        if (c === '$') {
          j++;
          while (j < n && /[0-9A-Fa-f_]/.test(src[j])) j++;
          const v = parseInt(src.slice(i + 1, j).replace(/_/g, ''), 16);
          adv(j - i);
          toks.push({ k: 'int', v, pos: p });
          continue;
        }
        if (c === '%') {
          j++;
          while (j < n && /[01_]/.test(src[j])) j++;
          const v = parseInt(src.slice(i + 1, j).replace(/_/g, ''), 2);
          adv(j - i);
          toks.push({ k: 'int', v, pos: p });
          continue;
        }
        while (j < n && /[0-9]/.test(src[j])) j++;
        let isReal = false;
        if (src[j] === '.' && /[0-9]/.test(src[j + 1] || '')) {
          isReal = true; j++;
          while (j < n && /[0-9]/.test(src[j])) j++;
        }
        if ((src[j] === 'e' || src[j] === 'E') && /[0-9+-]/.test(src[j + 1] || '')) {
          isReal = true; j++;
          if (src[j] === '+' || src[j] === '-') j++;
          while (j < n && /[0-9]/.test(src[j])) j++;
        }
        const s = src.slice(i, j);
        adv(j - i);
        if (isReal) toks.push({ k: 'real', v: decimalToReal(s), pos: p });
        else toks.push({ k: 'int', v: parseInt(s, 10), pos: p });
        continue;
      }
      // strings: 'abc', #13, #$0D, combined
      if (c === "'" || c === '#') {
        let s = '';
        while (i < n && (src[i] === "'" || src[i] === '#')) {
          if (src[i] === "'") {
            adv();
            for (;;) {
              if (i >= n || src[i] === '\n') throw new CompileError('unterminated string', p);
              if (src[i] === "'") {
                if (src[i + 1] === "'") { s += "'"; adv(2); continue; }
                adv(); break;
              }
              s += src[i]; adv();
            }
          } else {
            adv();
            let j = i, v;
            if (src[j] === '$') {
              j++;
              while (j < n && /[0-9A-Fa-f]/.test(src[j])) j++;
              v = parseInt(src.slice(i + 1, j), 16);
            } else {
              while (j < n && /[0-9]/.test(src[j])) j++;
              v = parseInt(src.slice(i, j), 10);
            }
            if (isNaN(v) || v > 255) throw new CompileError('bad character code', p);
            adv(j - i);
            s += String.fromCharCode(v);
          }
        }
        toks.push({ k: 'str', v: s, pos: p });
        continue;
      }
      const two = src.slice(i, i + 2);
      if (OPS2.includes(two)) {
        adv(2);
        const v = two === '(.' ? '[' : two === '.)' ? ']' : two;
        toks.push({ k: 'op', v, pos: p });
        continue;
      }
      if (OPS1.includes(c)) {
        adv();
        toks.push({ k: 'op', v: c, pos: p });
        continue;
      }
      throw new CompileError(`unexpected character '${c}'`, p);
    }
  }

  lex(text, file);
  if (condStack.length) throw new CompileError('missing $ENDIF', { file, line: 0, col: 0 });
  toks.push({ k: 'eof', v: '<end of file>', pos: toks.length ? toks[toks.length - 1].pos : { file, line: 1, col: 1 } });
  return toks;
}
