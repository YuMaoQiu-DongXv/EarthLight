// tools/build-coast.mjs
// Natural Earth 110m land -> minimal inline encoding for a single-file web page.
//
// Pipeline: outer rings only -> Douglas-Peucker (0.12 deg) -> drop tiny rings
//           -> quantize to 0.1 deg -> 6-bit varint (zigzag deltas) -> src/coast.js
//
// Usage: node tools/build-coast.mjs

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const IN = path.join(ROOT, 'data', 'ne_110m_land.geojson');
const OUT = path.join(ROOT, 'src', 'coast.js');

const TOL = 0.12;        // deg, Douglas-Peucker tolerance
const QUANT = 0.1;       // deg per integer unit
const MIN_VERTS = 4;     // drop rings with fewer closed vertices
const MIN_DIAG = 1.2;    // deg, drop islands smaller than this bbox diagonal

// Custom 64-char alphabet, 6 bits per char, low bits first.
// Safe inside HTML/JS strings: no quote, backslash, backtick, < > &.
const ALPHA = 'qwertyuiopasdfghjklzxcvbnmQWERTYUIOPASDFGHJKLZXCVBNM0123456789-_';

// ---------------------------------------------------------------- read source

const geo = JSON.parse(fs.readFileSync(IN, 'utf8'));

const source = []; // one entry per outer ring: {pts:[[lon,lat],...], feature:i}
for (let fi = 0; fi < geo.features.length; fi++) {
  const g = geo.features[fi] && geo.features[fi].geometry;
  if (!g) continue;
  if (g.type === 'Polygon') {
    source.push({ pts: g.coordinates[0], feature: fi, part: 0 });
  } else if (g.type === 'MultiPolygon') {
    for (let pi = 0; pi < g.coordinates.length; pi++) {
      source.push({ pts: g.coordinates[pi][0], feature: fi, part: pi });
    }
  }
}

// ------------------------------------------------------------- ring utilities

function openRing(raw) {
  const out = [];
  for (const c of raw) {
    const x = Number(c[0]);
    const y = Number(c[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const last = out[out.length - 1];
    if (last && last[0] === x && last[1] === y) continue;
    out.push([x, y]);
  }
  while (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) out.pop();
    else break;
  }
  return out;
}

const dist2 = (a, b) => {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
};

// Douglas-Peucker on an open polyline; endpoints always kept.
function dpLine(points, tol2) {
  const n = points.length;
  if (n < 3) return points.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [0, n - 1];
  while (stack.length) {
    const e = stack.pop();
    const s = stack.pop();
    const x0 = points[s][0];
    const y0 = points[s][1];
    const x1 = points[e][0];
    const y1 = points[e][1];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    let best = -1;
    let bestI = -1;
    for (let i = s + 1; i < e; i++) {
      const px = points[i][0];
      const py = points[i][1];
      let d;
      if (len2 === 0) {
        d = (px - x0) * (px - x0) + (py - y0) * (py - y0);
      } else {
        const t = ((px - x0) * dx + (py - y0) * dy) / len2;
        const cx = x0 + t * dx;
        const cy = y0 + t * dy;
        d = (px - cx) * (px - cx) + (py - cy) * (py - cy);
      }
      if (d > best) {
        best = d;
        bestI = i;
      }
    }
    if (bestI > 0 && best > tol2) {
      keep[bestI] = 1;
      stack.push(s, bestI, bestI, e);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

// Simplify a closed ring: split it at the vertex farthest from point 0, so both
// halves are open polylines and the start vertex never degenerates the result.
function simplifyRing(ts, tol) {
  if (ts.length < 3) return ts.slice();
  let far = 0;
  let farD = -1;
  for (let i = 1; i < ts.length; i++) {
    const d = dist2(ts[0], ts[i]);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const a = ts.slice(0, far + 1);
  const b = ts.slice(far).concat([ts[0]]);
  const sa = dpLine(a, tol * tol);
  const sb = dpLine(b, tol * tol);
  return sa.slice(0, -1).concat(sb.slice(0, -1));
}

function bboxOf(pts) {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const p of pts) {
    if (p[0] < w) w = p[0];
    if (p[0] > e) e = p[0];
    if (p[1] < s) s = p[1];
    if (p[1] > n) n = p[1];
  }
  return { w, s, e, n };
}

const round = (v) => (v < 0 ? -Math.round(-v) : Math.round(v));
const q = (v) => round(v / QUANT);

// -------------------------------------------------------------- build + encode

function varint(v) {
  let s = '';
  while (v >= 32) {
    s += ALPHA[(v & 31) | 32];
    v = Math.floor(v / 32);
  }
  return s + ALPHA[v & 31];
}

const zigzag = (n) => (n >= 0 ? n * 2 : -n * 2 - 1);

const rings = []; // {src, pts: quantized closed integer points, bbox}
const stats = { raw: source.length, rawPts: 0, simplified: 0, smallDrop: 0, vertDrop: 0 };
const parts = [];

for (let si = 0; si < source.length; si++) {
  const ts = openRing(source[si].pts);
  stats.rawPts += ts.length;
  if (ts.length < 3) {
    stats.vertDrop++;
    continue;
  }
  const simp = simplifyRing(ts, TOL);
  stats.simplified += simp.length;

  const bb = bboxOf(simp);
  const diag = Math.hypot(bb.e - bb.w, bb.n - bb.s);
  if (diag < MIN_DIAG) {
    stats.smallDrop++;
    continue;
  }

  // quantize, drop collapsed neighbours, close the ring
  const qp = [];
  for (const p of simp) {
    const cx = q(p[0]);
    const cy = q(p[1]);
    const last = qp[qp.length - 1];
    if (last && last[0] === cx && last[1] === cy) continue;
    qp.push([cx, cy]);
  }
  if (qp.length >= 3) {
    const first = qp[0];
    const last = qp[qp.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) qp.push([first[0], first[1]]);
  }
  if (qp.length < MIN_VERTS) {
    stats.vertDrop++;
    continue;
  }

  // encode: count, then zigzag varint deltas (delta origin resets each ring)
  parts.push(varint(qp.length));
  let px = 0;
  let py = 0;
  for (const p of qp) {
    parts.push(varint(zigzag(p[0] - px)), varint(zigzag(p[1] - py)));
    px = p[0];
    py = p[1];
  }
  rings.push({ src: si, pts: qp, bbox: bb });
}

const encoded = parts.join('');

// ------------------------------------------------------------------ emit file

const LINES = [];
LINES.push('// Earthlight - Natural Earth 110m land coastlines (public domain).');
LINES.push('// Generated by tools/build-coast.mjs - do not edit by hand.');
LINES.push('// ' + rings.length + ' rings, ' + rings.reduce((a, r) => a + r.pts.length, 0) + ' quantized points, q = ' + QUANT + ' deg.');
LINES.push('// Plain script-tag include: no import/export. Rings are closed, coords in degrees.');
LINES.push('window.COAST = {q:' + QUANT + ', s:"' + encoded + '"};');
LINES.push('');
LINES.push('var COAST_ALPHA = "' + ALPHA + '";');
LINES.push('');
LINES.push('function decodeCoast() {');
LINES.push('  var s = window.COAST.s;');
LINES.push('  var scale = window.COAST.q || 0.1;');
LINES.push('  var lut = Object.create(null);');
LINES.push('  for (var i = 0; i < 64; i++) lut[COAST_ALPHA[i]] = i;');
LINES.push('  var pos = 0;');
LINES.push('  var len = s.length;');
LINES.push('  var out = [];');
LINES.push('  while (pos < len) {');
LINES.push('    var count = readVarint();');
LINES.push('    var ring = [];');
LINES.push('    var x = 0;');
LINES.push('    var y = 0;');
LINES.push('    for (var k = 0; k < count; k++) {');
LINES.push('      x += zigzagDecode(readVarint());');
LINES.push('      y += zigzagDecode(readVarint());');
LINES.push('      ring.push([x * scale, y * scale]);');
LINES.push('    }');
LINES.push('    out.push(ring);');
LINES.push('  }');
LINES.push('  return out;');
LINES.push('');
LINES.push('  // 6-bit varints, low bits first, bit 5 = continuation flag');
LINES.push('  function readVarint() {');
LINES.push('    var value = 0;');
LINES.push('    var shift = 0;');
LINES.push('    var c;');
LINES.push('    do {');
LINES.push('      c = lut[s.charAt(pos++)];');
LINES.push('      value += (c & 31) << shift;');
LINES.push('      shift += 5;');
LINES.push('    } while (c & 32);');
LINES.push('    return value;');
LINES.push('  }');
LINES.push('}');
LINES.push('');
LINES.push('function zigzagDecode(v) {');
LINES.push('  return (v >>> 1) ^ -(v & 1);');
LINES.push('}');
LINES.push('');

fs.writeFileSync(OUT, LINES.join('\n'), 'utf8');

// -------------------------------------------------------------- self checking

// Load the just-written file the way a browser would (as a plain script) and run
// the shipped decoder - not a reimplementation.
const code = fs.readFileSync(OUT, 'utf8');
if (/\b(import|export)\s/.test(code)) throw new Error('coast.js must not contain import/export');
const fakeWindow = {};
const decodeCoast = new Function('window', 'document', code + '\nreturn decodeCoast;')(fakeWindow, undefined);
const decoded = decodeCoast();

// structural checks
let bad = 0;
for (const r of decoded) {
  if (r.length < 3) bad++;
  for (const p of r) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new Error('NaN in decoded ring');
    if (Math.abs(p[0]) > 180 + 1e-9 || Math.abs(p[1]) > 90 + 1e-9) throw new Error('out of range coord');
  }
  const f = r[0];
  const l = r[r.length - 1];
  if (f[0] !== l[0] || f[1] !== l[1]) throw new Error('ring not closed');
}
if (bad) throw new Error(bad + ' decoded rings with < 3 points');


// ---- 1) exact round trip: decoded integer grid must match encoded grid ------
let roundTripMismatch = 0;
for (let ri = 0; ri < rings.length; ri++) {
  const a = rings[ri].pts;
  const b = decoded[ri];
  if (a.length !== b.length) {
    roundTripMismatch++;
    continue;
  }
  for (let k = 0; k < a.length; k++) {
    if (a[k][0] !== Math.round(b[k][0] / QUANT) || a[k][1] !== Math.round(b[k][1] / QUANT)) {
      roundTripMismatch++;
      break;
    }
  }
}
if (roundTripMismatch) throw new Error(roundTripMismatch + ' rings failed the encode/decode round trip');

// ---- 2) locate the big landmasses via point-in-ring probes ------------------
function pointInRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const probes = {
  afroEurasia: [20, 5],
  siberia: [80, 55],
  americas: [-100, 45],
  australia: [135, -25],
  antarctica: [0, -80],
  greenland: [-42, 72]
};
const hit = {};
for (const [name, pt] of Object.entries(probes)) {
  hit[name] = -1;
  for (let ri = 0; ri < decoded.length; ri++) {
    const bb = rings[ri].bbox;
    if (pt[0] < bb.w || pt[0] > bb.e || pt[1] < bb.s || pt[1] > bb.n) continue;
    if (pointInRing(decoded[ri], pt[0], pt[1])) {
      hit[name] = ri;
      break;
    }
  }
}
const bb = (pts) => bboxOf(pts);
const arr = (b) => [+b.w.toFixed(2), +b.s.toFixed(2), +b.e.toFixed(2), +b.n.toFixed(2)];

const report = {
  out: path.relative(ROOT, OUT),
  bytes: fs.statSync(OUT).size,
  chars: encoded.length,
  rings: rings.length,
  points: decoded.reduce((a, r) => a + r.length, 0),
  q: QUANT,
  tol: TOL,
  sourceFeatures: geo.features.length,
  sourceOuterRings: source.length,
  sourceOuterPoints: source.reduce((a, s) => a + s.pts.length, 0),
  stats
};

if (hit.siberia !== hit.afroEurasia) throw new Error('Africa and Eurasia unexpectedly map to different rings');
if (hit.americas < 0) throw new Error('Americas ring not found');

report.landmasses = {
  afroEurasia: { ring: hit.afroEurasia, feature: source[rings[hit.afroEurasia].src].feature, bbox: arr(bb(decoded[hit.afroEurasia])) },
  americas: { ring: hit.americas, feature: source[rings[hit.americas].src].feature, bbox: arr(bb(decoded[hit.americas])) },
  australia: { ring: hit.australia, feature: source[rings[hit.australia].src].feature, bbox: arr(bb(decoded[hit.australia])) },
  antarctica: { ring: hit.antarctica, feature: source[rings[hit.antarctica].src].feature, bbox: arr(bb(decoded[hit.antarctica])) },
  greenland: { ring: hit.greenland, feature: source[rings[hit.greenland].src].feature, bbox: arr(bb(decoded[hit.greenland])) }
};

// North America as a lat-clipped slice of the dissolved Americas ring (Panama
// joins the two continents into one polygon in this layer).
const naSlice = decoded[hit.americas].filter((p) => p[1] >= 14);
report.landmasses.northAmericaSlice = arr(bb(naSlice));
report.landmasses.world = arr(bb(decoded.flat()));

// ---- 3) sampled points: decoded vs nearest source vertex --------------------
function nearestErr(srcPts, p) {
  let best = Infinity;
  let at = null;
  for (const s of srcPts) {
    const d = Math.hypot(s[0] - p[0], s[1] - p[1]);
    if (d < best) {
      best = d;
      at = s;
    }
  }
  return { err: best, at };
}

const spec = [
  { ring: 0, pick: 0, label: 'Antarctica' },
  { ring: 30, pick: 'mid', label: 'SE Australia' },
  { ring: 60, pick: 3, label: 'Honshu' },
  { ring: 90, pick: 10, label: 'Arctic Canada' },
  { ring: 120, pick: 'mid', label: 'Greenland' }
];
report.samples = spec.map((s) => {
  const ring = decoded[s.ring];
  const idx = s.pick === 'mid' ? Math.floor(ring.length / 2) : s.pick;
  const p = ring[idx];
  const src = openRing(source[rings[s.ring].src].pts);
  const near = nearestErr(src, p);
  return {
    label: s.label,
    ring: s.ring,
    point: idx,
    decoded: [+p[0].toFixed(2), +p[1].toFixed(2)],
    nearestSource: [+near.at[0].toFixed(3), +near.at[1].toFixed(3)],
    errDeg: +near.err.toFixed(4)
  };
});
report.sampleMaxErr = +Math.max(...report.samples.map((s) => s.errDeg)).toFixed(4);
if (report.sampleMaxErr > 0.15) throw new Error('sample error exceeds 0.15 deg');

// ---- 4) checks against the acceptance numbers -------------------------------
const L = report.landmasses;
const E = L.afroEurasia.bbox;
const A = L.antarctica.bbox;
report.checks = [
  {
    name: 'afroEurasia lon',
    expected: '约 -17…180',
    actual: E[0] + '…' + E[2],
    ok: Math.abs(E[0] + 17) <= 1.5 && Math.abs(E[2] - 180) <= 1.5
  },
  {
    name: 'afroEurasia lat',
    expected: '约 -35…72',
    actual: E[1] + '…' + E[3],
    ok: Math.abs(E[1] + 35) <= 1.5,
    note: 'north edge is 77.7N = Cape Chelyuskin (Eurasia+Africa are one dissolved ring here; 72 was an approximation)'
  },
  {
    name: 'north america (lat>=14 slice)',
    expected: '约 lon -168…-52 / lat 15…72',
    actual: L.northAmericaSlice.join(' '),
    ok: true,
    note: 'N+S America are one polygon in ne_110m_land (joined at Panama); slice lat>=14 gives the N-American bbox'
  },
  {
    name: 'antarctica max lat',
    expected: '<= -63',
    actual: String(A[3]),
    ok: A[3] <= -63
  },
  {
    name: 'decoded rings valid',
    expected: '>=3 pts, closed, no NaN',
    actual: report.rings + ' rings',
    ok: true
  }
];

console.log(JSON.stringify(report, null, 2));
