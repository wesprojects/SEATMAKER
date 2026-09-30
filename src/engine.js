/* ============================================================
   SEATMAKER ENGINE — DXF in, seats + clean floor plan + VSDX out.
   Pure functions, no DOM. Runs in the browser and in Node tests.
   ============================================================ */
const SM = (() => {

/* ---------- DXF parsing ---------- */
// Only the entity types the engine uses keep their tags; everything
// else is kept as a bare record so sequences (INSERT/ATTRIB/SEQEND,
// POLYLINE/VERTEX) stay intact while memory stays low on 80 MB files.
const KEEP = new Set(['INSERT', 'ATTRIB', 'SEQEND', 'LINE', 'LWPOLYLINE', 'POLYLINE', 'VERTEX',
  'CIRCLE', 'ARC', 'ELLIPSE', 'SPLINE', 'TEXT', 'MTEXT', 'BLOCK', 'ENDBLK']);

function parseDXF(text) {
  if (text.startsWith('AutoCAD Binary DXF')) throw new Error('This is a binary DXF. Save it from AutoCAD as an ASCII DXF (AutoCAD 2013 DXF).');
  const L = text.split(/\r?\n/);
  const n = L.length >> 1;
  const blocks = new Map();          // name -> {base:[x,y,z], ents:[]}
  const ms = [];                     // model space records
  const layers = new Map();          // name -> {off, frozen}
  const owners = new Map();          // handle -> first 330 (dictionaries)
  const filters = [];                // SPATIAL_FILTER tag lists
  const header = {};
  let sec = null, expectName = false, cur = null, curBlock = null, hdrVar = null;
  const flush = () => {
    if (!cur) return;
    const t = cur.t;
    if (sec === 'ENTITIES') {
      if (!(t === 'VERTEX' || t === 'SEQEND' || t === 'ATTRIB') && getv(cur, 67) === '1') { cur = null; return; }
      ms.push(cur);
    } else if (sec === 'BLOCKS') {
      if (t === 'BLOCK') {
        const name = getv(cur, 2).trim();
        curBlock = { name, base: [num(cur, 10), num(cur, 20), num(cur, 30)], ents: [] };
        blocks.set(name, curBlock);
      } else if (t === 'ENDBLK') curBlock = null;
      else if (curBlock) curBlock.ents.push(cur);
    } else if (sec === 'TABLES' && t === 'LAYER') {
      const col = parseInt(getv(cur, 62, '7'), 10), fl = parseInt(getv(cur, 70, '0'), 10);
      layers.set(getv(cur, 2), { off: col < 0, frozen: (fl & 1) === 1 });
    } else if (sec === 'OBJECTS') {
      if (t === 'SPATIAL_FILTER') filters.push(cur);
      const h = getv(cur, 5), o = getv(cur, 330);
      if (h && o) owners.set(h.trim(), o.trim());
    }
    cur = null;
  };
  for (let k = 0; k < n; k++) {
    const code = parseInt(L[2 * k], 10);
    const val = L[2 * k + 1];
    if (code === 0) {
      flush();
      const v = val.trim();
      if (v === 'SECTION') { expectName = true; continue; }
      if (v === 'ENDSEC') { sec = null; continue; }
      if (v === 'EOF') break;
      const keepTags = sec === 'BLOCKS' || sec === 'ENTITIES' ? KEEP.has(v)
        : sec === 'TABLES' ? v === 'LAYER'
        : sec === 'OBJECTS' ? true : false;
      cur = { t: v, c: keepTags ? [] : null, v: keepTags ? [] : null, full: keepTags };
      if (!keepTags && (sec === 'OBJECTS')) { cur.c = []; cur.v = []; cur.full = false; }
      continue;
    }
    if (expectName && code === 2) { sec = val.trim(); expectName = false; continue; }
    if (sec === 'HEADER') {
      if (code === 9) hdrVar = val.trim();
      else if (hdrVar) (header[hdrVar] = header[hdrVar] || {})[code] = val.trim();
      continue;
    }
    if (!cur || !cur.c) continue;
    if (sec === 'OBJECTS' && cur.t !== 'SPATIAL_FILTER' && !(code === 5 || code === 330)) continue;
    cur.c.push(code); cur.v.push(val);
  }
  flush();
  blocks.set('__MS__', { name: '__MS__', base: [0, 0, 0], ents: ms });
  return { blocks, layers, owners, filters, header };
}
function getv(r, code, d) { const i = r.c ? r.c.indexOf(code) : -1; return i < 0 ? d : r.v[i]; }
function num(r, code, d = 0) { const i = r.c ? r.c.indexOf(code) : -1; return i < 0 ? d : parseFloat(r.v[i]); }
function all(r, code) { const o = []; if (!r.c) return o; for (let i = 0; i < r.c.length; i++) if (r.c[i] === code) o.push(parseFloat(r.v[i])); return o; }

/* ---------- 3x4 affine matrices ---------- */
const I = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
function mul(A, B) {
  const R = new Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      R[r * 4 + c] = A[r * 4] * B[c] + A[r * 4 + 1] * B[4 + c] + A[r * 4 + 2] * B[8 + c] + (c === 3 ? A[r * 4 + 3] : 0);
    }
  }
  return R;
}
const ap = (M, x, y, z) => [M[0] * x + M[1] * y + M[2] * z + M[3], M[4] * x + M[5] * y + M[6] * z + M[7], M[8] * x + M[9] * y + M[10] * z + M[11]];
function aaa(nx, ny, nz) {        // AutoCAD arbitrary axis algorithm -> OCS basis as 3x4
  const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
  let ax;
  if (Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64) ax = [nz, 0, -nx];      // Wy x N
  else ax = [-ny, nx, 0];                                                    // Wz x N
  let la = Math.hypot(...ax); ax = ax.map(v => v / la);
  let ay = [ny * ax[2] - nz * ax[1], nz * ax[0] - nx * ax[2], nx * ax[1] - ny * ax[0]];
  la = Math.hypot(...ay); ay = ay.map(v => v / la);
  return [ax[0], ay[0], nx, 0, ax[1], ay[1], ny, 0, ax[2], ay[2], nz, 0];
}
const isStdExt = r => { const z = num(r, 230, 1); return Math.abs(num(r, 210, 0)) < 1e-12 && Math.abs(num(r, 220, 0)) < 1e-12 && z > 0; };
const ocsOf = r => isStdExt(r) ? null : aaa(num(r, 210, 0), num(r, 220, 0), num(r, 230, 1));
function insertMatrix(r, base) {
  const ip = [num(r, 10), num(r, 20), num(r, 30)];
  const sx = num(r, 41, 1), sy = num(r, 42, 1), sz = num(r, 43, 1);
  const a = num(r, 50, 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const L = [c * sx, -s * sy, 0, 0, s * sx, c * sy, 0, 0, 0, 0, sz, 0];
  const O = ocsOf(r) || I();
  const OL = mul(O, L);
  const t = ap(O, ...ip), b = ap(OL, ...base);
  OL[3] = t[0] - b[0]; OL[7] = t[1] - b[1]; OL[11] = t[2] - b[2];
  return OL;
}

/* ---------- entity -> polylines (local coords) ---------- */
function arcPts(cx, cy, r, a0, a1) {
  if (a1 < a0) a1 += 2 * Math.PI;
  const n = Math.max(4, Math.ceil((a1 - a0) / (Math.PI / 24)));
  const o = [];
  for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; o.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return o;
}
function bulgeSeg(p0, p1, b, out) {
  if (Math.abs(b) < 1e-9) { out.push(p1); return; }
  const th = 4 * Math.atan(b), ch = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  if (ch < 1e-9) { out.push(p1); return; }
  const r = ch / (2 * Math.sin(th / 2)), mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
  const d = r * Math.cos(th / 2), ux = (p1[0] - p0[0]) / ch, uy = (p1[1] - p0[1]) / ch;
  const cx = mx - uy * d, cy = my + ux * d;
  const n = Math.max(3, Math.ceil(Math.abs(th) / (Math.PI / 24)));
  for (let i = 1; i <= n; i++) {
    const t = th * i / n, c = Math.cos(t), s = Math.sin(t);
    out.push([cx + (p0[0] - cx) * c - (p0[1] - cy) * s, cy + (p0[0] - cx) * s + (p0[1] - cy) * c]);
  }
}
function bspline(ctrl, k, deg) {
  const t0 = k[deg], t1 = k[k.length - deg - 1], N = Math.max(8, ctrl.length * 4), o = [];
  for (let i = 0; i <= N; i++) {
    const t = t0 + (t1 - t0) * i / N;
    let s = deg; while (s < ctrl.length - 1 && k[s + 1] <= t) s++;
    const d = []; for (let j = 0; j <= deg; j++) d.push(ctrl[j + s - deg].slice());
    for (let r = 1; r <= deg; r++) for (let j = deg; j >= r; j--) {
      const den = k[j + 1 + s - r] - k[j + s - deg], a = den === 0 ? 0 : (t - k[j + s - deg]) / den;
      d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
    }
    o.push(d[deg]);
  }
  return o;
}
// returns list of point arrays [[x,y,z],...] in block coords
function entPolys(r) {
  const t = r.t;
  const O = ocsOf(r);
  const ocs = (pts, z) => pts.map(p => O ? ap(O, p[0], p[1], z) : [p[0], p[1], z]);
  if (t === 'LINE') return [[[num(r, 10), num(r, 20), num(r, 30)], [num(r, 11), num(r, 21), num(r, 31)]]];
  if (t === 'LWPOLYLINE') {
    const pts = [], bl = [];
    for (let i = 0; i < r.c.length; i++) {
      if (r.c[i] === 10) { pts.push([parseFloat(r.v[i]), 0]); bl.push(0); }
      else if (r.c[i] === 20 && pts.length) pts[pts.length - 1][1] = parseFloat(r.v[i]);
      else if (r.c[i] === 42 && pts.length) bl[bl.length - 1] = parseFloat(r.v[i]);
    }
    if (pts.length < 2) return [];
    const closed = (num(r, 70, 0) & 1) === 1, o = [pts[0]];
    const m = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < m; i++) bulgeSeg(pts[i], pts[(i + 1) % pts.length], bl[i], o);
    return [ocs(o, num(r, 38, 0))];
  }
  if (t === 'CIRCLE') return [ocs(arcPts(num(r, 10), num(r, 20), num(r, 40), 0, 2 * Math.PI), num(r, 30))];
  if (t === 'ARC') return [ocs(arcPts(num(r, 10), num(r, 20), num(r, 40), num(r, 50) * Math.PI / 180, num(r, 51) * Math.PI / 180), num(r, 30))];
  if (t === 'ELLIPSE') {
    const c = [num(r, 10), num(r, 20), num(r, 30)], m = [num(r, 11), num(r, 21), num(r, 31)], ra = num(r, 40, 1);
    let s = num(r, 41, 0), e = num(r, 42, 2 * Math.PI); if (e < s) e += 2 * Math.PI;
    const nz = [num(r, 210, 0), num(r, 220, 0), num(r, 230, 1)];
    const mn = [(nz[1] * m[2] - nz[2] * m[1]) * ra, (nz[2] * m[0] - nz[0] * m[2]) * ra, (nz[0] * m[1] - nz[1] * m[0]) * ra];
    const N = Math.max(8, Math.ceil((e - s) / (Math.PI / 24))), o = [];
    for (let i = 0; i <= N; i++) { const a = s + (e - s) * i / N, ca = Math.cos(a), sa = Math.sin(a); o.push([c[0] + m[0] * ca + mn[0] * sa, c[1] + m[1] * ca + mn[1] * sa, c[2] + m[2] * ca + mn[2] * sa]); }
    return [o];
  }
  if (t === 'SPLINE') {
    const deg = num(r, 71, 3), k = all(r, 40), xs = all(r, 10), ys = all(r, 20), zs = all(r, 30);
    const cp = xs.map((x, i) => [x, ys[i], zs[i] || 0]);
    if (cp.length > deg && k.length === cp.length + deg + 1 && all(r, 41).length === 0) return [bspline(cp, k, deg)];
    const fx = all(r, 11), fy = all(r, 21), fz = all(r, 31);
    const fp = fx.map((x, i) => [x, fy[i], fz[i] || 0]);
    return [fp.length > 1 ? fp : cp];
  }
  return [];
}

/* ---------- clipping ---------- */
function inside(x, y, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[j];
    if ((y1 > y) !== (y2 > y) && x < (x2 - x1) * (y - y1) / (y2 - y1) + x1) c = !c;
  }
  return c;
}
function clipToPoly(pts, poly) {
  const res = []; let cur = [];
  for (let s = 0; s < pts.length - 1; s++) {
    const a = pts[s], b = pts[s + 1], ts = [0, 1];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const d1x = b[0] - a[0], d1y = b[1] - a[1], d2x = q[0] - p[0], d2y = q[1] - p[1];
      const den = d1x * d2y - d1y * d2x; if (Math.abs(den) < 1e-12) continue;
      const t = ((p[0] - a[0]) * d2y - (p[1] - a[1]) * d2x) / den, u = ((p[0] - a[0]) * d1y - (p[1] - a[1]) * d1x) / den;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
    }
    ts.sort((x, y) => x - y);
    for (let i = 0; i < ts.length - 1; i++) {
      const t0 = ts[i], t1 = ts[i + 1];
      const P = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0], Q = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
      if (inside((P[0] + Q[0]) / 2, (P[1] + Q[1]) / 2, poly)) {
        if (cur.length && Math.hypot(cur[cur.length - 1][0] - P[0], cur[cur.length - 1][1] - P[1]) < 1e-6) cur.push(Q);
        else { if (cur.length > 1) res.push(cur); cur = [P, Q]; }
      } else { if (cur.length > 1) res.push(cur); cur = []; }
    }
  }
  if (cur.length > 1) res.push(cur);
  return res;
}

/* ---------- walk: flatten everything once ---------- */
// Produces world-space 2D polylines tagged with layer, text labels,
// every block insert (with world matrix and CAP description), and the
// set of desk-block inserts each polyline sits under.
function flatten(dxf, onProgress) {
  const { blocks, layers, owners, filters } = dxf;
  const clipmap = new Map();
  for (const f of filters) {
    const d = getv(f, 330, '').trim(), xd = owners.get(d), ins = xd && owners.get(xd);
    if (!ins) continue;
    let pts = []; const xs = all(f, 10), ys = all(f, 20);
    for (let i = 0; i < Math.min(xs.length, ys.length); i++) pts.push([xs[i], ys[i]]);
    const m = all(f, 40);
    const A1 = m.length >= 12 ? m.slice(0, 12) : I();
    if (pts.length === 2) { const [[x0, y0], [x1, y1]] = pts; pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; }
    if (pts.length >= 3) clipmap.set(ins, pts.map(([x, y]) => ap(A1, x, y, 0)));
  }
  const hidden = name => { const l = layers.get(name); return !!(l && (l.off || l.frozen)); };
  const polys = [], texts = [], inserts = [];
  let wrapped = false;
  const msEnts = blocks.get('__MS__').ents;
  const nonTrivial = msEnts.filter(e => !['SEQEND', 'ATTRIB', 'VERTEX'].includes(e.t));
  if (nonTrivial.length === 1 && nonTrivial[0].t === 'INSERT') wrapped = true;

  function walk(name, M, layerIn, clips, ancestors, depth) {
    const blk = blocks.get(name); if (!blk || depth > 16) return;
    const ents = blk.ents;
    for (let i = 0; i < ents.length; i++) {
      const r = ents[i];
      if (!r.full) continue;
      let lay = getv(r, 8, '0');
      if (lay === '0' && layerIn) lay = layerIn;
      if (hidden(lay)) {
        if (r.t === 'POLYLINE') while (i + 1 < ents.length && ents[i + 1].t === 'VERTEX') i++;
        continue;
      }
      const t = r.t;
      if (t === 'INSERT') {
        const bn = getv(r, 2, '').trim(), b = blocks.get(bn); if (!b) continue;
        const Mi = mul(M, insertMatrix(r, b.base));
        const h = (getv(r, 5, '') || '').trim();
        let cl = clips;
        if (clipmap.has(h)) {
          // A1 (first SPATIAL_FILTER matrix) maps the boundary into block space
          cl = clips.concat([clipmap.get(h).map(p => { const w = ap(Mi, p[0], p[1], p[2]); return [w[0], w[1]]; })]);
        }
        // attributes that follow this insert
        let cappd = '';
        for (let j = i + 1; j < ents.length && (ents[j].t === 'ATTRIB' || ents[j].t === 'SEQEND'); j++) {
          if (ents[j].t === 'ATTRIB' && (getv(ents[j], 2, '') || '').trim() === 'CAPPD') cappd = getv(ents[j], 1, '');
          if (ents[j].t === 'SEQEND') break;
        }
        const id = inserts.length;
        inserts.push({ name: bn, M: Mi, layer: lay, cappd, depth, clipped: cl });
        walk(bn, Mi, lay, cl, ancestors.concat(id), depth + 1);
        continue;
      }
      let geoms = [];
      if (t === 'POLYLINE') {
        const fl = num(r, 70, 0), vs = [];
        while (i + 1 < ents.length && ents[i + 1].t === 'VERTEX') { const v = ents[++i]; vs.push([num(v, 10), num(v, 20), num(v, 30)]); }
        if ((fl & 1) && vs.length) vs.push(vs[0]);
        if (vs.length > 1 && !(fl & (16 | 64))) geoms = [vs];
      } else if (t === 'TEXT' || t === 'MTEXT') {
        let txt = '';
        for (let k = 0; k < r.c.length; k++) if (r.c[k] === 3) txt += r.v[k];
        txt += getv(r, 1, '');
        const w = ap(M, num(r, 10), num(r, 20), num(r, 30));
        if (clips.every(c => inside(w[0], w[1], c))) texts.push({ layer: lay, text: txt, x: w[0], y: w[1] });
        continue;
      } else if (t === 'ATTRIB' || t === 'SEQEND' || t === 'VERTEX') continue;
      else geoms = entPolys(r);
      for (const g of geoms) {
        if (!g || g.length < 2) continue;
        let w = g.map(p => { const q = ap(M, p[0], p[1], p[2]); return [q[0], q[1]]; });
        let pieces = [w];
        for (const c of clips) pieces = pieces.flatMap(pc => clipToPoly(pc, c));
        for (const q of pieces) polys.push({ layer: lay, pts: q, anc: ancestors });
      }
    }
  }
  walk('__MS__', I(), null, [], [], 0);
  if (onProgress) onProgress('flattened');
  return { polys, texts, inserts, clipCount: clipmap.size, wrapped };
}

/* ---------- block footprints (2D, desk/chair geometry only) ---------- */
function blockBox(dxf, name, memo = new Map(), depth = 0) {
  if (memo.has(name)) return memo.get(name);
  const b = dxf.blocks.get(name); let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  memo.set(name, null);
  if (b && depth < 12) {
    for (let i = 0; i < b.ents.length; i++) {
      const r = b.ents[i]; if (!r.full) continue;
      let pts = [];
      if (r.t === 'INSERT') {
        const bn = getv(r, 2, '').trim(), bb = blockBox(dxf, bn, memo, depth + 1), bd = dxf.blocks.get(bn);
        if (!bb || !bd) continue;
        const M = insertMatrix(r, bd.base);
        pts = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]].map(([x, y]) => ap(M, x, y, 0));
      } else if (r.t === 'POLYLINE') {
        while (i + 1 < b.ents.length && b.ents[i + 1].t === 'VERTEX') { const v = b.ents[++i]; pts.push([num(v, 10), num(v, 20)]); }
      } else if (['LINE', 'LWPOLYLINE', 'CIRCLE', 'ARC', 'ELLIPSE', 'SPLINE'].includes(r.t)) pts = entPolys(r).flat();
      for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[0] > x1) x1 = p[0]; if (p[1] > y1) y1 = p[1]; }
    }
  }
  const res = x0 <= x1 ? [x0, y0, x1, y1] : null;
  memo.set(name, res); return res;
}

/* ---------- seat modes ---------- */
// OFF, CHAIR (one 30x30 seat at the block's center), DESK (one seat = the
// block footprint), PAIR (back-to-back: footprint split in two across its depth)
function defaultMode(name, cappd) {
  if (/^LaCOUR\s*-\s*60L\s*x\s*33D/i.test(name)) return 'PAIR';
  if (/task chair/i.test(cappd || '')) return 'CHAIR';
  return 'OFF';
}
function candidates(dxf, flat) {
  const map = new Map();
  for (const ins of flat.inserts) {
    let c = map.get(ins.name);
    if (!c) { c = { name: ins.name, count: 0, cappd: ins.cappd || '', layer: ins.layer }; map.set(ins.name, c); }
    c.count++; if (!c.cappd && ins.cappd) c.cappd = ins.cappd;
  }
  const list = [...map.values()].filter(c =>
    c.cappd || /FURN|DESK|SEAT|CHAIR|WORK|STATION|BENCH/i.test(c.layer + ' ' + c.name));
  for (const c of list) c.mode = defaultMode(c.name, c.cappd);
  list.sort((a, b) => (a.mode === 'OFF') - (b.mode === 'OFF') || b.count - a.count || a.name.localeCompare(b.name));
  return list;
}
const normAngle = a => {
  a = Math.atan2(Math.sin(a), Math.cos(a));
  if (a > Math.PI / 2 + 1e-6) a -= Math.PI;
  if (a <= -Math.PI / 2 + 1e-6) a += Math.PI;
  return Math.abs(a) < 1e-6 ? 0 : a;
};
function seatsFromBlocks(dxf, flat, modes) {
  const memo = new Map(), seats = [], deskIns = new Set();
  flat.inserts.forEach((ins, id) => {
    const mode = modes.get(ins.name) || 'OFF'; if (mode === 'OFF') return;
    const M = ins.M, bb = blockBox(dxf, ins.name, memo);
    const ang = normAngle(Math.atan2(M[4], M[0]));
    const at = (x, y) => ap(M, x, y, 0);
    if (mode === 'CHAIR' || !bb) {
      const c = bb ? at((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2) : at(0, 0);
      seats.push({ x: c[0], y: c[1], w: 30, h: 30, a: 0, kind: 'O', row: c[1], src: 'auto' });
      return;
    }
    deskIns.add(id);
    const w = bb[2] - bb[0], h = bb[3] - bb[1], spine = at(0, (bb[1] + bb[3]) / 2)[1];
    if (mode === 'DESK') {
      const c = at((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2);
      seats.push({ x: c[0], y: c[1], w, h, a: ang, kind: 'B', row: c[1], src: 'auto' });
    } else {
      const ym = (bb[1] + bb[3]) / 2, rowY = at(0, 0)[1];
      for (const [ya, yb] of [[bb[1], ym], [ym, bb[3]]]) {
        const c = at((bb[0] + bb[2]) / 2, (ya + yb) / 2);
        seats.push({ x: c[0], y: c[1], w, h: yb - ya, a: ang, kind: 'B', row: rowY, src: 'auto' });
      }
    }
  });
  return { seats, deskIns };
}
// Exploded desk runs: linework on a DESK layer that is not inside a desk block.
function looseRuns(flat, deskIns) {
  const pieces = flat.polys.filter(p => /DESK/i.test(p.layer) && !p.anc.some(a => deskIns.has(a)));
  const bbs = pieces.map(p => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of p.pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    return [x0, y0, x1, y1];
  });
  const par = bbs.map((_, i) => i);
  const f = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  const order = bbs.map((_, i) => i).sort((a, b) => bbs[a][0] - bbs[b][0]);
  for (let ii = 0; ii < order.length; ii++) {
    const i = order[ii], a = bbs[i];
    for (let jj = ii + 1; jj < order.length; jj++) {
      const j = order[jj], b = bbs[j];
      if (b[0] > a[2] + 1) break;
      if (a[1] <= b[3] + 1 && b[1] <= a[3] + 1) par[f(i)] = f(j);
    }
  }
  const groups = new Map();
  bbs.forEach((b, i) => {
    const k = f(i), g = groups.get(k);
    if (!g) groups.set(k, b.slice()); else { g[0] = Math.min(g[0], b[0]); g[1] = Math.min(g[1], b[1]); g[2] = Math.max(g[2], b[2]); g[3] = Math.max(g[3], b[3]); }
  });
  const runs = [], skipped = [];
  for (const g of groups.values()) {
    const w = g[2] - g[0], h = g[3] - g[1], k = Math.round(w / 60);
    if (k >= 1 && Math.abs(w - 60 * k) < 1.5 && h >= 30 && h <= 35) {
      const seats = [];
      for (let i = 0; i < k; i++) seats.push({ x: g[0] + 60 * i + 30, y: (g[1] + g[3]) / 2, w: 60, h, a: 0, kind: 'B', row: g[1], src: 'loose' });
      runs.push({ box: g, seats });
    } else if (w > 5 && h > 5) skipped.push({ box: g, w, h });
  }
  return { runs, skipped };
}

/* ---------- plan background ---------- */
const EXCL = /^(A-FURN|AFU|LACOUR|EDGES|G-IMPT|FRAME|A-ANNO|A-DIM|XREF|C-DETAILS|A-EQPM-IDEN|A-AREA-IDEN|LJ-DWG|A-DOOR-IDEN|DEFPOINTS)/i;
const baseLayer = l => l.split('$0$').pop();
const isFurn = l => { const b = baseLayer(l); return /^(A-FURN|AFU|LACOUR|EDGES|G-IMPT)/i.test(b) || b === '0'; };
const keepBg = l => { const b = baseLayer(l); return !EXCL.test(b) && b !== '0'; };
function pct(arr, p) { const a = Float64Array.from(arr).sort(); return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))]; }
function planBox(flat) {
  const xs = [], ys = [];
  for (const p of flat.polys) if (/WALL|COLS|GLAZ/i.test(baseLayer(p.layer))) for (const [x, y] of p.pts) { xs.push(x); ys.push(y); }
  if (xs.length < 50) for (const p of flat.polys) for (const [x, y] of p.pts) { xs.push(x); ys.push(y); }
  if (!xs.length) return [0, 0, 100, 100];
  return [pct(xs, 0.002) - 40, pct(ys, 0.002) - 40, pct(xs, 0.998) + 40, pct(ys, 0.998) + 40];
}
const cleanText = t => t.replace(/\\P/g, ' ').replace(/\\[A-Za-z][^;\\]*;/g, '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
function scene(flat) {
  const box = planBox(flat);
  const inBox = pts => pts.every(([x, y]) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]);
  const bg = [], furn = [];
  for (const p of flat.polys) {
    if (!inBox(p.pts)) continue;
    if (keepBg(p.layer)) bg.push(p.pts); else if (isFurn(p.layer)) furn.push(p.pts);
  }
  const labels = flat.texts.filter(t => baseLayer(t.layer) === 'A-AREA-IDEN' && t.x >= box[0] && t.x <= box[2] && t.y >= box[1] && t.y <= box[3])
    .map(t => ({ text: cleanText(t.text), x: t.x, y: t.y })).filter(t => t.text)
    .filter((t, i, a) => !a.slice(0, i).some(u => u.text === t.text && Math.hypot(u.x - t.x, u.y - t.y) < 24));
  return { box, bg, furn, labels };
}

/* ---------- numbering ---------- */
function numberSeats(seats, start = 1) {
  const s = seats.slice().sort((a, b) => {
    const ka = a.kind === 'O' ? [0, -Math.round(a.y / 45), a.x, 0] : [1, -Math.round(a.row / 50), Math.round(a.x), -a.y];
    const kb = b.kind === 'O' ? [0, -Math.round(b.y / 45), b.x, 0] : [1, -Math.round(b.row / 50), Math.round(b.x), -b.y];
    for (let i = 0; i < 4; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  });
  s.forEach((x, i) => x.num = start + i);
  return s;
}

/* ---------- VSDX ---------- */
const SHEETS = { 'ANSI C': [22, 17], 'ARCH D': [36, 24], 'TABLOID': [17, 11] };
const SCALES = [[96, '1/8" = 1\'-0"'], [128, '3/32" = 1\'-0"'], [192, '1/16" = 1\'-0"'], [384, '1/32" = 1\'-0"']];
function pickScale(box, sheet) {
  const [sw, sh] = SHEETS[sheet] || SHEETS['ANSI C'];
  for (const [r, label] of SCALES) if ((box[2] - box[0]) / r <= sw - 1.5 && (box[3] - box[1]) / r <= sh - 1.5) return { ratio: r, label };
  const r = Math.ceil(Math.max((box[2] - box[0]) / (sw - 1.5), (box[3] - box[1]) / (sh - 1.5)));
  return { ratio: r, label: '1:' + r };
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = v => { let s = v.toFixed(4); if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, ''); return s === '-0' ? '0' : s; };

function vsdxParts(sc, seats, opt) {
  const sheet = opt.sheet || 'ANSI C', [sw, shh] = SHEETS[sheet];
  const { ratio } = pickScale(sc.box, sheet);
  const PW = sw * ratio, PH = shh * ratio, box = sc.box;
  const OX = (PW - (box[2] - box[0])) / 2 - box[0], OY = (PH - (box[3] - box[1])) / 2 - box[1];
  const tx = x => x + OX, ty = y => y + OY;
  const out = []; let sid = 0;
  const CH = 250;
  for (let k = 0; k < sc.bg.length; k += CH) {
    const chunk = sc.bg.slice(k, k + CH);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of chunk) for (const [x, y] of p) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    x0 = tx(x0); y0 = ty(y0); x1 = tx(x1); y1 = ty(y1);
    const w = Math.max(x1 - x0, 0.01), h = Math.max(y1 - y0, 0.01);
    const geo = chunk.map((p, gi) => '<Section N="Geometry" IX="' + gi + '"><Cell N="NoFill" V="1"/><Cell N="NoLine" V="0"/><Cell N="NoShow" V="0"/><Cell N="NoSnap" V="0"/>' +
      p.map(([x, y], ri) => '<Row T="' + (ri ? 'LineTo' : 'MoveTo') + '" IX="' + (ri + 1) + '"><Cell N="X" V="' + fmt(tx(x) - x0) + '"/><Cell N="Y" V="' + fmt(ty(y) - y0) + '"/></Row>').join('') + '</Section>').join('');
    const i = ++sid;
    out.push('<Shape ID="' + i + '" NameU="Floor Plan.' + i + '" Name="Floor Plan.' + i + '" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">' +
      '<Cell N="PinX" V="' + fmt(x0 + w / 2) + '"/><Cell N="PinY" V="' + fmt(y0 + h / 2) + '"/><Cell N="Width" V="' + fmt(w) + '"/><Cell N="Height" V="' + fmt(h) + '"/>' +
      '<Cell N="LocPinX" V="' + fmt(w / 2) + '" F="Width*0.5"/><Cell N="LocPinY" V="' + fmt(h / 2) + '" F="Height*0.5"/><Cell N="Angle" V="0"/>' +
      '<Cell N="LineWeight" V="0.0069"/><Cell N="LineColor" V="#595959"/><Cell N="FillPattern" V="0"/><Cell N="LayerMember" V="0"/>' + geo + '</Shape>');
  }
  if (opt.labels !== false) for (const l of sc.labels) {
    const i = ++sid, w = 144, h = 10;
    out.push('<Shape ID="' + i + '" NameU="Label.' + i + '" Name="Label.' + i + '" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">' +
      '<Cell N="PinX" V="' + fmt(tx(l.x)) + '"/><Cell N="PinY" V="' + fmt(ty(l.y)) + '"/><Cell N="Width" V="' + w + '"/><Cell N="Height" V="' + h + '"/>' +
      '<Cell N="LocPinX" V="' + w / 2 + '" F="Width*0.5"/><Cell N="LocPinY" V="' + h / 2 + '" F="Height*0.5"/>' +
      '<Cell N="LinePattern" V="0"/><Cell N="FillPattern" V="0"/><Cell N="LayerMember" V="0"/>' +
      '<Section N="Character"><Row IX="0"><Cell N="Font" V="Arial"/><Cell N="Color" V="#1F5A8A"/><Cell N="Size" V="0.0833"/><Cell N="Style" V="0"/></Row></Section>' +
      '<Text>' + esc(l.text) + '</Text></Shape>');
  }
  const txtSize = ratio <= 96 ? 0.1111 : 0.0833;
  for (const s of seats) {
    const i = ++sid;
    out.push('<Shape ID="' + i + '" NameU="Seat ' + s.num + '" Name="Seat ' + s.num + '" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">' +
      '<Cell N="PinX" V="' + fmt(tx(s.x)) + '"/><Cell N="PinY" V="' + fmt(ty(s.y)) + '"/><Cell N="Width" V="' + fmt(s.w) + '"/><Cell N="Height" V="' + fmt(s.h) + '"/>' +
      '<Cell N="LocPinX" V="' + fmt(s.w / 2) + '" F="Width*0.5"/><Cell N="LocPinY" V="' + fmt(s.h / 2) + '" F="Height*0.5"/><Cell N="Angle" V="' + fmt(s.a) + '"/>' +
      '<Cell N="LineWeight" V="0.0104"/><Cell N="LineColor" V="#404040"/><Cell N="LinePattern" V="1"/>' +
      '<Cell N="FillForegnd" V="#FFF3A0"/><Cell N="FillPattern" V="1"/><Cell N="Rounding" V="3"/>' +
      '<Cell N="VerticalAlign" V="1"/><Cell N="LayerMember" V="1"/>' +
      '<Section N="Character"><Row IX="0"><Cell N="Font" V="Arial"/><Cell N="Color" V="#000000"/><Cell N="Size" V="' + txtSize + '"/><Cell N="Style" V="1"/></Row></Section>' +
      '<Section N="Paragraph"><Row IX="0"><Cell N="HorzAlign" V="1"/></Row></Section>' +
      '<Section N="Geometry" IX="0"><Cell N="NoFill" V="0"/><Cell N="NoLine" V="0"/><Cell N="NoShow" V="0"/><Cell N="NoSnap" V="0"/>' +
      '<Row T="RelMoveTo" IX="1"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row><Row T="RelLineTo" IX="2"><Cell N="X" V="1"/><Cell N="Y" V="0"/></Row>' +
      '<Row T="RelLineTo" IX="3"><Cell N="X" V="1"/><Cell N="Y" V="1"/></Row><Row T="RelLineTo" IX="4"><Cell N="X" V="0"/><Cell N="Y" V="1"/></Row>' +
      '<Row T="RelLineTo" IX="5"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row></Section>' +
      '<Text>' + s.num + '</Text></Shape>');
  }
  const NS = 'xmlns="http://schemas.microsoft.com/office/visio/2012/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xml:space="preserve"';
  const HDR = '<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n';
  const pageName = esc(opt.pageName || 'Floor Plan');
  const layer = (ix, name, lock) => '<Row IX="' + ix + '"><Cell N="Name" V="' + name + '"/><Cell N="Color" V="255"/><Cell N="Status" V="0"/><Cell N="Visible" V="1"/>' +
    '<Cell N="Print" V="1"/><Cell N="Active" V="0"/><Cell N="Lock" V="' + lock + '"/><Cell N="Snap" V="1"/><Cell N="Glue" V="1"/><Cell N="NameUniv" V="' + name + '"/><Cell N="ColorTrans" V="0"/></Row>';
  const pages = HDR + '<Pages ' + NS + '><Page ID="0" NameU="' + pageName + '" Name="' + pageName + '" ViewScale="-1" ViewCenterX="' + fmt(PW / 2) + '" ViewCenterY="' + fmt(PH / 2) + '">' +
    '<PageSheet LineStyle="0" FillStyle="0" TextStyle="0"><Cell N="PageWidth" V="' + fmt(PW) + '" U="FT"/><Cell N="PageHeight" V="' + fmt(PH) + '" U="FT"/>' +
    '<Cell N="PageScale" V="' + fmt(12 / ratio) + '" U="IN"/><Cell N="DrawingScale" V="12" U="FT"/><Cell N="DrawingSizeType" V="0"/><Cell N="DrawingScaleType" V="3"/>' +
    '<Cell N="InhibitSnap" V="0"/><Cell N="PageLockReplace" V="0"/><Cell N="PageLockDuplicate" V="0"/><Cell N="UIVisibility" V="0"/><Cell N="ShdwType" V="0"/>' +
    '<Cell N="PrintPageOrientation" V="2"/><Cell N="PageShapeSplit" V="1"/><Section N="Layer">' + layer(0, 'Floor Plan', 1) + layer(1, 'Seats', 0) + '</Section></PageSheet><Rel r:id="rId1"/></Page></Pages>';
  const cells = [['EnableLineProps', '1'], ['EnableFillProps', '1'], ['EnableTextProps', '1'], ['HideForApply', '0'], ['LineWeight', '0.01041666666666667'], ['LineColor', '0'], ['LinePattern', '1'], ['Rounding', '0'],
    ['EndArrowSize', '2'], ['BeginArrow', '0'], ['EndArrow', '0'], ['LineCap', '0'], ['BeginArrowSize', '2'], ['LineColorTrans', '0'], ['CompoundType', '0'], ['FillForegnd', '1'], ['FillBkgnd', '0'], ['FillPattern', '1'],
    ['ShdwForegnd', '0'], ['ShdwPattern', '0'], ['FillForegndTrans', '0'], ['FillBkgndTrans', '0'], ['ShdwForegndTrans', '0'], ['ShapeShdwType', '0'], ['ShapeShdwOffsetX', '0'], ['ShapeShdwOffsetY', '0'],
    ['LeftMargin', '0.05555555555555555'], ['RightMargin', '0.05555555555555555'], ['TopMargin', '0.05555555555555555'], ['BottomMargin', '0.05555555555555555'],
    ['VerticalAlign', '1'], ['TextBkgnd', '0'], ['TextBkgndTrans', '0'], ['TextDirection', '0'], ['DefaultTabStop', '0.5']];
  const style0 = '<StyleSheet ID="0" NameU="No Style" IsCustomNameU="1" Name="No Style" IsCustomName="1">' + cells.map(([k, v]) => '<Cell N="' + k + '" V="' + v + '"/>').join('') +
    '<Section N="Character"><Row IX="0"><Cell N="Font" V="Calibri"/><Cell N="Color" V="0"/><Cell N="Style" V="0"/><Cell N="Case" V="0"/><Cell N="Pos" V="0"/><Cell N="FontScale" V="1"/><Cell N="Size" V="0.1666666666666667"/><Cell N="ColorTrans" V="0"/></Row></Section>' +
    '<Section N="Paragraph"><Row IX="0"><Cell N="IndFirst" V="0"/><Cell N="IndLeft" V="0"/><Cell N="IndRight" V="0"/><Cell N="SpLine" V="-1.2"/><Cell N="SpBefore" V="0"/><Cell N="SpAfter" V="0"/><Cell N="HorzAlign" V="1"/><Cell N="Bullet" V="0"/></Row></Section></StyleSheet>';
  const document = HDR + '<VisioDocument ' + NS + '><DocumentSettings TopPage="0" DefaultTextStyle="0" DefaultLineStyle="0" DefaultFillStyle="0" DefaultGuideStyle="0">' +
    '<GlueSettings>9</GlueSettings><SnapSettings>65847</SnapSettings><SnapExtensions>34</SnapExtensions><SnapAngles/><DynamicGridEnabled>1</DynamicGridEnabled><ProtectStyles>0</ProtectStyles>' +
    '<ProtectShapes>0</ProtectShapes><ProtectMasters>0</ProtectMasters><ProtectBkgnds>0</ProtectBkgnds></DocumentSettings><Colors><ColorEntry IX="0" RGB="#000000"/><ColorEntry IX="1" RGB="#FFFFFF"/></Colors>' +
    '<FaceNames><FaceName NameU="Calibri" UnicodeRanges="-536859905 -1073732485 9 0" CharSets="536871423 0" Panose="2 15 5 2 2 2 4 3 2 4" Flags="325"/>' +
    '<FaceName NameU="Arial" UnicodeRanges="-536859905 -1073711037 9 0" CharSets="1073742335 -65536" Panose="2 11 6 4 2 2 2 2 2 4" Flags="325"/></FaceNames><StyleSheets>' + style0 + '</StyleSheets></VisioDocument>';
  const windows = HDR + '<Windows ClientWidth="1600" ClientHeight="900" ' + NS + '><Window ID="0" WindowType="Drawing" WindowState="1073741824" WindowLeft="0" WindowTop="0" WindowWidth="1600" WindowHeight="900" ContainerType="Page" Page="0" ViewScale="-1" ViewCenterX="' + fmt(PW / 2) + '" ViewCenterY="' + fmt(PH / 2) + '">' +
    '<ShowRulers>1</ShowRulers><ShowGrid>0</ShowGrid><ShowPageBreaks>0</ShowPageBreaks><ShowGuides>1</ShowGuides><ShowConnectionPoints>0</ShowConnectionPoints><GlueSettings>9</GlueSettings><SnapSettings>65847</SnapSettings><SnapExtensions>34</SnapExtensions><SnapAngles/><DynamicGridEnabled>1</DynamicGridEnabled><TabSplitterPos>0.5</TabSplitterPos></Window></Windows>';
  const R = 'http://schemas.openxmlformats.org/package/2006/relationships';
  return [
    ['[Content_Types].xml', HDR + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/visio/document.xml" ContentType="application/vnd.ms-visio.drawing.main+xml"/><Override PartName="/visio/pages/pages.xml" ContentType="application/vnd.ms-visio.pages+xml"/><Override PartName="/visio/pages/page1.xml" ContentType="application/vnd.ms-visio.page+xml"/>' +
      '<Override PartName="/visio/windows.xml" ContentType="application/vnd.ms-visio.windows+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>'],
    ['_rels/.rels', HDR + '<Relationships xmlns="' + R + '"><Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/document" Target="visio/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>'],
    ['docProps/core.xml', HDR + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>' + pageName + ' Seating Plan</dc:title><dc:creator>SEATMAKER</dc:creator></cp:coreProperties>'],
    ['docProps/app.xml', HDR + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Microsoft Visio</Application><AppVersion>16.0000</AppVersion></Properties>'],
    ['visio/document.xml', document],
    ['visio/_rels/document.xml.rels', HDR + '<Relationships xmlns="' + R + '"><Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/pages" Target="pages/pages.xml"/><Relationship Id="rId2" Type="http://schemas.microsoft.com/visio/2010/relationships/windows" Target="windows.xml"/></Relationships>'],
    ['visio/windows.xml', windows],
    ['visio/pages/pages.xml', pages],
    ['visio/pages/_rels/pages.xml.rels', HDR + '<Relationships xmlns="' + R + '"><Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/page" Target="page1.xml"/></Relationships>'],
    ['visio/pages/page1.xml', HDR + '<PageContents ' + NS + '><Shapes>' + out.join('') + '</Shapes></PageContents>'],
  ];
}

/* ---------- minimal ZIP (stored) ---------- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zip(files) {
  const enc = new TextEncoder(), chunks = [], central = []; let off = 0;
  const d = new Date(), dt = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(), tm = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  for (const [name, text] of files) {
    const nb = enc.encode(name), data = typeof text === 'string' ? enc.encode(text) : text, crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, tm, true); h.setUint16(12, dt, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
    h.setUint16(26, nb.length, true); h.setUint16(28, 0, true);
    chunks.push(new Uint8Array(h.buffer), nb, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, tm, true); c.setUint16(14, dt, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, nb.length, true); c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), nb);
    off += 30 + nb.length + data.length;
  }
  const cs = central.reduce((a, b) => a + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cs, true); e.setUint32(16, off, true);
  const all = [...chunks, ...central, new Uint8Array(e.buffer)], total = all.reduce((a, b) => a + b.length, 0), out = new Uint8Array(total);
  let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}

return { parseDXF, flatten, candidates, seatsFromBlocks, looseRuns, scene, numberSeats, vsdxParts, zip, pickScale, SHEETS, blockBox };
})();
if (typeof module !== 'undefined') module.exports = SM;
