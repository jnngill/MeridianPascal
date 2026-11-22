// MERIDIAN Pascal - type system helpers

export const T = {};

function mkInt(name, size, signed) {
  const bits = size * 8;
  const lo = signed ? -(2 ** (bits - 1)) : 0;
  const hi = signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
  return { k: 'int', name, size, signed, lo, hi };
}

T.shortint = mkInt('shortint', 1, true);
T.byte = mkInt('byte', 1, false);
T.integer = mkInt('integer', 2, true);
T.word = mkInt('word', 2, false);
T.longint = mkInt('longint', 4, true);
T.longword = mkInt('longword', 4, false);
T.char = { k: 'char', name: 'char', size: 1, lo: 0, hi: 255 };
T.boolean = { k: 'bool', name: 'boolean', size: 1, lo: 0, hi: 1 };
T.real = { k: 'real', name: 'real', size: 4 };
T.nil = { k: 'nil', name: 'nil', size: 0 };
T.untyped = { k: 'untyped', name: 'untyped', size: 0 };
T.string = { k: 'string', name: 'string', max: 255, size: 256 };
T.void = { k: 'void', name: 'void', size: 0 };

export function isOrdinal(t) {
  return t && (t.k === 'int' || t.k === 'char' || t.k === 'bool' || t.k === 'enum');
}
export function isInt(t) { return t && t.k === 'int'; }
export function isReal(t) { return t && t.k === 'real'; }
export function isNumeric(t) { return isInt(t) || isReal(t); }
export function isStringy(t) { return t && (t.k === 'string' || t.k === 'char'); }
export function isPtr(t) { return t && (t.k === 'ptr' || t.k === 'nil'); }
export function isScalar(t) { return isOrdinal(t) || isReal(t) || isPtr(t); }
export function isStruct(t) {
  return t && (t.k === 'string' || t.k === 'array' || t.k === 'record' || t.k === 'set');
}

// base type of an ordinal (for subranges / compat checks)
export function ordBase(t) {
  if (t.k === 'int') return 'int';
  if (t.k === 'enum') return t.base || t;
  return t.k;
}

// ordinal subrange type derived from base
export function subrange(base, lo, hi) {
  if (base.k === 'int') {
    let size, signed;
    if (lo >= 0 && hi <= 255) { size = 1; signed = false; }
    else if (lo >= -128 && hi <= 127) { size = 1; signed = true; }
    else if (lo >= 0 && hi <= 65535 && hi > 32767) { size = 2; signed = false; }
    else if (lo >= -32768 && hi <= 32767) { size = 2; signed = true; }
    else if (lo >= 0 && hi > 2147483647) { size = 4; signed = false; }
    else { size = 4; signed = true; }
    return { k: 'int', name: `${lo}..${hi}`, size, signed, lo, hi };
  }
  if (base.k === 'char') return { k: 'char', name: 'char', size: 1, lo, hi };
  if (base.k === 'bool') return { k: 'bool', name: 'boolean', size: 1, lo, hi };
  if (base.k === 'enum') {
    const b = base.base || base;
    return { k: 'enum', name: b.name, size: b.size, lo, hi, names: b.names, base: b };
  }
  throw new Error('bad subrange base');
}

export function typeName(t) {
  if (!t) return '?';
  switch (t.k) {
    case 'ptr': return t.name || ('^' + (t.to ? typeName(t.to) : 'untyped'));
    case 'array': return t.name || `array[${t.lo}..${t.hi}] of ${typeName(t.elem)}`;
    case 'string': return t.max === 255 ? 'string' : `string[${t.max}]`;
    case 'set': return t.name || `set of ${typeName(t.base)}`;
    default: return t.name || t.k;
  }
}

// integer type that holds a constant value
export function intTypeFor(v) {
  if (v >= -32768 && v <= 32767) return T.integer;
  if (v >= 0 && v <= 65535) return T.word;
  if (v >= -2147483648 && v <= 2147483647) return T.longint;
  return T.longword;
}

export function fitsType(v, t) {
  return v >= t.lo && v <= t.hi;
}

// wrap a JS number to the range of integer type t
export function wrapTo(v, t) {
  const bits = t.size * 8;
  if (bits === 32) return t.signed ? (v | 0) : (v >>> 0);
  const m = 2 ** bits;
  let r = ((v % m) + m) % m;
  if (t.signed && r >= m / 2) r -= m;
  return r;
}

// IEEE single precision bits of a JS number
export function realBits(x) {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setFloat32(0, x, true);
  return dv.getInt32(0, true);
}

export function sameType(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.k !== b.k) return false;
  switch (a.k) {
    case 'int': return a.size === b.size && a.signed === b.signed;
    case 'char': case 'bool': case 'real': return true;
    case 'enum': return (a.base || a) === (b.base || b);
    case 'string': return true;
    case 'ptr': return !a.to || !b.to || a.to === b.to || sameType(a.to, b.to) && a.to.k !== 'record';
    case 'set': return true;
    default: return false;
  }
}
