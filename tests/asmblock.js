// asm ... end blocks: the errors, in both compilers (the PC compiler and the
// cartridge's on-device compiler) and for both targets, at the right line;
// an asm block in a unit of your own (on the device).
import { build } from './harness.js';
import { ncRun } from './nc.js';

let fail = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) { fail++; if (extra) console.log(extra); } };

// each: a program, the line of the error, what the message says (PC / device)
const PROG = (body, decl = '') => `program E;\nvar g: integer;\n${decl}\nbegin\n${body}\nend.\n`;
const CASES = [
  { what: 'an unknown name', src: PROG('  asm\n    nop\n    lda nowhere\n  end;'), line: 7, pc: /unknown identifier 'nowhere'/, nc: /undefined symbol nowhere/i },
  { what: 'a local of an outer routine', src: PROG('',
      'procedure Outer;\nvar o: integer;\n  procedure Inner;\n  begin\n    asm\n      lda o\n    end;\n  end;\nbegin Inner; end;'),
    line: 8, pc: /outer routine/, nc: /cannot be used in asm: o/i },
  { what: 'a string constant', src: PROG('  asm\n    lda #Name\n  end;', "const Name = 'abc';"), line: 6, pc: /only integer constants/, nc: /cannot be used in asm: Name/i },
  { what: 'an unknown instruction', src: PROG('  asm\n    nop\n\n    frobnicate 1\n  end;'), line: 8, pc: /asm: unknown/, nc: /./ },
  { what: 'no end', src: 'program E;\nbegin\n  asm\n    nop\n', line: 0, pc: /no 'end'|has no end/, nc: /asm block has no end/ },
];

for (const c of CASES) {
  for (const t of ['m816', 'schub']) {
    const src = t === 'schub' ? c.src.replace(/lda #?/g, 'li a0, ').replace(/\bnop\b/g, 'addi zero, zero, 0') : c.src;
    // the PC compiler
    const r = build(src, t, 'e.pas');
    const e = r.errors && r.errors[0];
    check(`PC ${t}: ${c.what}: line ${c.line}`, !r.ok && e && c.pc.test(e.msg) && (!c.line || e.line === c.line), JSON.stringify(e));
    // the on-device compiler ({$SCHUB} at the top shifts the lines by one)
    const o = ncRun((t === 'schub' ? '{$SCHUB}\n' : '') + src, { frames: 2000 });
    const first = o.output.split('\n')[0];
    const m = /^ERROR (\S*) ?(\d+):(\d+) (.*)$/.exec(first);
    const want = c.line ? c.line + (t === 'schub' ? 1 : 0) : 0;
    check(`device ${t}: ${c.what}: line ${want}`, m && c.nc.test(m[4]) && (!want || +m[2] === want), first);
  }
}

// a unit of your own with an asm block, and an error in one
const UNIT = 'unit MyAsm;\ninterface\nfunction Plus1(n: integer): integer;\nimplementation\n' +
  'function Plus1(n: integer): integer;\nbegin\n  asm\n    lda n\n    inc a\n    sta Plus1\n  end;\nend;\nend.\n';
const MAIN = "program U;\nuses MyAsm;\nbegin\n  WriteLn('P ', Plus1(41));\nend.\n";
let o = ncRun(MAIN, { frames: 3000, files: { 'MYASM.PAS': UNIT } });
check('device: an asm block in a unit', /^COMPILED/.test(o.output) && /P 42/.test(o.output), o.output);
o = ncRun(MAIN, { frames: 3000, files: { 'MYASM.PAS': UNIT.replace('inc a', 'inc nowhere') } });
check('device: an error in a unit\'s asm block names the unit and its line', /^ERROR MYASM\.PAS 9:/.test(o.output), o.output);

console.log(fail ? `${fail} failed` : 'all ok');
process.exit(fail ? 1 : 0);
