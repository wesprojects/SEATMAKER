// Engine check against a drawing on disk: node test/test.js <file.dxf> [expected seat count]
// Drawings are client files and are not kept in this repository.
const fs = require('fs'), path = require('path'), SM = require('../src/engine.js');
const [file, expect] = process.argv.slice(2);
if (!file) { console.log('usage: node test/test.js <file.dxf> [expected seats]'); process.exit(1); }
const dxf = SM.parseDXF(fs.readFileSync(file, 'latin1'));
const flat = SM.flatten(dxf);
const modes = new Map(SM.candidates(dxf, flat).map(c => [c.name, c.mode]));
const { seats, deskIns } = SM.seatsFromBlocks(dxf, flat, modes);
const loose = SM.looseRuns(flat, deskIns);
const all = SM.numberSeats(seats.filter(s => !s.atTable).concat(loose.runs.flatMap(r => r.seats)));
const atTable = seats.filter(s => s.atTable).length;
const sc = SM.scene(flat);
const bytes = SM.zip(SM.vsdxParts(sc, all, { sheet: 'ANSI C', pageName: 'Test' }));
const out = path.join(require('os').tmpdir(), path.basename(file, '.dxf') + '-SEATING.vsdx');
fs.writeFileSync(out, bytes);
console.log(path.basename(file), '->', all.length, 'seats,', atTable, 'chairs at tables left out,', loose.runs.length, 'loose runs,', loose.skipped.length, 'loose pieces skipped,',
  flat.clipCount, 'clips,', sc.bg.length, 'plan lines,', sc.labels.length, 'room names,', SM.pickScale(sc.box, 'ANSI C').label, '->', out);
if (expect && +expect !== all.length) { console.error('FAIL: expected', expect); process.exit(1); }
