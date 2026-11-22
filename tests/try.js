import fs from 'node:fs';
import { build, run } from './harness.js';
const [,, file, target = 'm816', frames = '600'] = process.argv;
const r = build(fs.readFileSync(file, 'latin1'), target, file);
if (!r.ok) { console.log(r.errors); process.exit(1); }
const o = run(r, { frames: +frames });
console.log(o.screen);
console.log(`--- state=${o.state} msg=${o.message} frames=${o.frames}`);
