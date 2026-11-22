// MERIDIAN Pascal IDE - emulator view: canvas, keyboard, mouse, sound
import { Meridian, SCANCODES } from '/emu/meridian.js';

// browser key -> MERIDIAN kernel key code
function keyCode(e) {
  switch (e.key) {
    case 'Enter': return 13;
    case 'Backspace': return 8;
    case 'Escape': return 3;
    case 'ArrowRight': return 0x1c;
    case 'ArrowLeft': return 0x1d;
    case 'ArrowUp': return 0x1e;
    case 'ArrowDown': return 0x1f;
    case 'Home': return e.shiftKey ? 0x0c : 0x01;
    case 'Delete': return 0x7f;
    case 'Insert': return 0x0e;
    case 'Tab': return 9;
  }
  if (e.ctrlKey && /^[0-9]$/.test(e.key)) return 0x10 + +e.key;
  if (e.key.length === 1) {
    const c = e.key.charCodeAt(0);
    if (c < 256) return c;
  }
  return 0;
}
// joystick 1 on the keyboard: arrows, Ctrl/Space = fire A, Alt = fire B
const JOYKEYS = { ArrowRight: 1, ArrowLeft: 2, ArrowDown: 4, ArrowUp: 8, ControlLeft: 16, Space: 16, AltLeft: 32, Enter: 256 };

class OrgelAudio {
  constructor() {
    this.ctx = null;
    this.voices = [];
    this.muted = false;
  }
  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.25;
    this.master.connect(this.ctx.destination);
    const noise = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = noise;
    for (let v = 0; v < 4; v++) {
      const g = this.ctx.createGain();
      g.gain.value = 0;
      g.connect(this.master);
      const pan = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
      if (pan) { g.disconnect(); g.connect(pan); pan.connect(this.master); }
      this.voices.push({ g, pan, osc: null, src: null, wave: 0, gate: false, freq: 0 });
    }
  }
  setMuted(m) { this.muted = m; if (this.master) this.master.gain.value = m ? 0 : 0.25; }
  // SID-like envelope times in seconds
  static ATT = [0.002, 0.008, 0.016, 0.024, 0.038, 0.056, 0.068, 0.08, 0.1, 0.25, 0.5, 0.8, 1, 3, 5, 8];
  static DEC = [0.006, 0.024, 0.048, 0.072, 0.114, 0.168, 0.204, 0.24, 0.3, 0.75, 1.5, 2.4, 3, 9, 15, 24];
  update(io) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    const masterVol = (io[0x543] & 15) / 15;
    for (let v = 0; v < 4; v++) {
      const b = 0x500 + v * 16;
      const V = this.voices[v];
      const freq = (io[b] | (io[b + 1] << 8)) * 1000000 / 16777216;
      const ctl = io[b + 4];
      const wave = ctl & 0xf0;
      const gate = (ctl & 1) !== 0;
      const vol = (io[b + 7] & 15) / 15 * masterVol;
      if (wave !== V.wave) {
        if (V.osc) { V.osc.stop(); V.osc.disconnect(); V.osc = null; }
        if (wave & 0x80) {
          V.osc = this.ctx.createBufferSource();
          V.osc.buffer = this.noiseBuf; V.osc.loop = true;
        } else if (wave) {
          V.osc = this.ctx.createOscillator();
          V.osc.type = wave & 0x40 ? 'square' : wave & 0x20 ? 'sawtooth' : 'triangle';
        }
        if (V.osc) { V.osc.connect(V.g); V.osc.start(); }
        V.wave = wave;
      }
      if (V.osc && freq !== V.freq) {
        if (V.osc.frequency) V.osc.frequency.setTargetAtTime(Math.max(1, freq), t, 0.002);
        else V.osc.playbackRate.value = Math.max(0.05, freq / 440);
        V.freq = freq;
      }
      if (V.pan) {
        const p = io[b + 8];
        const l = p >> 4, r = p & 15;
        V.pan.pan.value = p === 0 || p === 0xff ? 0 : (r - l) / 15;
      }
      if (gate !== V.gate) {
        const g = V.g.gain;
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
        if (gate) {
          const a = OrgelAudio.ATT[io[b + 5] >> 4], d = OrgelAudio.DEC[io[b + 5] & 15];
          const sus = (io[b + 6] >> 4) / 15;
          g.linearRampToValueAtTime(vol, t + a);
          g.setTargetAtTime(vol * sus, t + a, d / 3);
        } else {
          const r = OrgelAudio.DEC[io[b + 6] & 15];
          g.setTargetAtTime(0, t, r / 3);
        }
        V.gate = gate;
      }
    }
  }
  silence() {
    for (const V of this.voices) {
      if (V.osc) { try { V.osc.stop(); } catch { } V.osc.disconnect(); V.osc = null; }
      V.wave = 0; V.gate = false; V.g.gain.value = 0;
    }
  }
}

export class EmuView {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.img = this.ctx.createImageData(640, 240);
    this.buf32 = new Uint32Array(this.img.data.buffer);
    this.onStatus = opts.onStatus || (() => {});
    this.onFileSaved = opts.onFileSaved || null;
    this.audio = new OrgelAudio();
    this.m = null;
    this.running = false;
    this.paused = false;
    this.raf = 0;
    this.joy = 0;
    this.fps = 0;
    canvas.tabIndex = 0;
    canvas.addEventListener('keydown', (e) => this.keydown(e));
    canvas.addEventListener('keyup', (e) => this.keyup(e));
    canvas.addEventListener('mousemove', (e) => this.mouse(e));
    canvas.addEventListener('mousedown', (e) => { this.mouse(e); if (this.m) this.m.mouse.b |= 1 << [0, 2, 1][e.button]; canvas.focus(); });
    canvas.addEventListener('mouseup', (e) => { if (this.m) this.m.mouse.b &= ~(1 << [0, 2, 1][e.button]); });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => { if (this.m && document.activeElement === canvas) { e.preventDefault(); this.m.mouse.wheel = (this.m.mouse.wheel + (e.deltaY < 0 ? 1 : -1)) & 255; } }, { passive: false });
  }

  async init() {
    const get = async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer());
    this.roms = { kern: await get('/emu/rom/kern.bin'), sys: await get('/emu/rom/dos.bin') };
    this.m = new Meridian(this.roms);
    this.m.onFileSaved = (d, n, data) => this.onFileSaved && this.onFileSaved(d, n, data);
    this.draw();
  }

  setDriveFiles(drive, files) {
    const map = this.m.drives[drive];
    map.clear();
    for (const [n, d] of files) map.set(n.toUpperCase(), d);
  }

  reset() {
    this.stop();
    const drives = this.m ? this.m.drives : null;
    this.m = new Meridian(this.roms);
    if (drives) this.m.drives = drives;
    this.m.onFileSaved = (d, n, data) => this.onFileSaved && this.onFileSaved(d, n, data);
    this.audio.silence();
    this.draw();
    this.status();
  }

  run(mer) {
    this.reset();
    this.audio.start();
    const info = this.m.loadMer(mer);
    this.m.startProgram(info.start);
    this.running = true;
    this.paused = false;
    this.canvas.focus();
    this.lastT = performance.now();
    this.frames = 0;
    this.loop();
    return info;
  }

  loop() {
    cancelAnimationFrame(this.raf);
    let acc = 0;
    let last = performance.now();
    let fpsT = last, fpsN = 0;
    const frame = (now) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(frame);
      if (this.paused) { last = now; return; }
      acc += Math.min(100, now - last);
      last = now;
      const t0 = performance.now();
      let n = 0;
      while (acc >= 1000 / 59.95 && n < 4) {
        this.m.joy[0] = this.joy;
        this.m.runFrame();
        acc -= 1000 / 59.95;
        n++;
        fpsN++;
        if (this.m.state !== 'running') break;
        if (performance.now() - t0 > 40) { acc = 0; break; }
      }
      this.audio.update(this.m.io);
      this.draw();
      if (now - fpsT > 1000) { this.fps = Math.round(fpsN * 1000 / (now - fpsT)); fpsT = now; fpsN = 0; this.status(); }
      if (this.m.state !== 'running') {
        this.running = false;
        this.audio.silence();
        this.status();
      }
    };
    this.raf = requestAnimationFrame(frame);
  }

  // plug in a cartridge (.MOD) and start it like at power-on
  runCartridge(mod) {
    this.reset();
    this.audio.start();
    this.m.insertCartridge(mod);
    this.m.startCartridge();
    this.running = true;
    this.paused = false;
    this.canvas.focus();
    this.loop();
  }

  stop() {
    if (this.m && this.m.state === 'running') this.m.halt('stopped by the user');
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.audio.silence();
    this.draw();
    this.status();
  }
  pause(p) { this.paused = p; this.status(); }

  draw() {
    if (!this.m) return;
    this.m.render(this.buf32);
    this.ctx.putImageData(this.img, 0, 0);
  }
  status() {
    if (!this.m) return;
    const m = this.m;
    this.onStatus({
      state: this.paused && this.running ? 'paused' : m.state, message: m.message, fps: this.fps,
      cycles: m.totalCycles, schub: m.rv.running, schubError: m.schubFault || m.rv.error,
    });
  }
  screenText() { return this.m ? this.m.screenText() : ''; }
  output() { return this.m ? this.m.output : ''; }

  keydown(e) {
    if (!this.m) return;
    // while the screen has the focus, every key belongs to the MERIDIAN
    e.preventDefault();
    e.stopPropagation();
    const sc = SCANCODES[e.code];
    this.m.keyState(sc, true);
    if (JOYKEYS[e.code]) this.joy |= JOYKEYS[e.code];
    // like the kernel: Ctrl + letter gives no character (programs read the key table)
    const k = e.ctrlKey && !/^[0-9]$/.test(e.key) ? 0 : keyCode(e);
    if (k) this.m.pushKey(k);
  }
  keyup(e) {
    if (!this.m) return;
    e.preventDefault();
    e.stopPropagation();
    const sc = SCANCODES[e.code];
    this.m.keyState(sc, false);
    if (JOYKEYS[e.code]) this.joy &= ~JOYKEYS[e.code];
  }
  mouse(e) {
    if (!this.m) return;
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) / r.width * 320);
    const y = Math.floor((e.clientY - r.top) / r.height * 240);
    this.m.mouse.x = Math.max(0, Math.min(319, x));
    this.m.mouse.y = Math.max(0, Math.min(239, y));
  }
  typeText(s) {
    if (!this.m) return;
    let i = 0;
    const tick = () => {
      if (i >= s.length) return;
      const c = s.charCodeAt(i++);
      this.m.pushKey(c === 10 ? 13 : c);
      setTimeout(tick, 30);
    };
    tick();
  }
}
