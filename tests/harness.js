// Compile a Pascal program and run it headless in the emulator.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../compiler/compile.js';
import { Meridian } from '../emu/meridian.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
export const roms = {
  kern: new Uint8Array(fs.readFileSync(path.join(root, 'emu/rom/kern.bin'))),
  sys: new Uint8Array(fs.readFileSync(path.join(root, 'emu/rom/dos.bin'))),
};
export function loader(dir) {
  return (name) => {
    for (const d of [dir, path.join(root, 'lib')]) {
      const p = path.join(d, name + '.pas');
      if (fs.existsSync(p)) { const text = fs.readFileSync(p, "latin1"); if (d !== path.join(root, "lib") && /^s*({[^}]*}s*)*programb/i.test(text)) continue; return { text, name: p }; }
    }
    return null;
  };
}
export function build(src, target = 'm816', file = 'test.pas', dir = root) {
  return compile(src, file, { target, loadUnit: loader(dir) });
}
// run: returns {screen, state, message, frames}
export function run(res, { frames = 600, keys = '', untilIdle = true } = {}) {
  const m = new Meridian(roms);
  const info = m.loadMer(res.mer);
  m.startProgram(info.start);
  let k = 0, f = 0;
  for (; f < frames; f++) {
    if (keys && k < keys.length && f % 3 === 0) m.pushKey(keys.charCodeAt(k++));
    m.runFrame();
    if (untilIdle && m.state !== 'running') break;
  }
  return { screen: m.screenText(), output: m.output, state: m.state, message: m.message, frames: f, m };
}
