// Earthlight — 地图投影模块测试（零依赖，node src/projections.test.mjs）
//
// 归一化约定（与 projections.js 一致）：
//   整幅宽 = 2（x ∈ [-1,1]），高 = 2*aspect，y 向上为正。
//   所以赤道对称投影的极点满足 y = aspect，而不是 aspect/2。
//   任务文字里的“极点 y = aspect/2”与宽 = 2 时的几何关系矛盾；本测试按
//   “bbox 高 = 2*aspect、aspect = 高/宽”这一自洽约束断言。否则 Mollweide
//   会被压成 4:1，Winkel Tripel 也会比真实图幅扁一半。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourcePath = fileURLToPath(new URL('./projections.js', import.meta.url));
const source = readFileSync(sourcePath, 'utf8');

// 用假 window 执行，验证模块确实以 window.PROJ 形式暴露（不是 ESM）。
const windowStub = {};
new Function('window', source)(windowStub);
const PROJ = windowStub.PROJ;
const KEYS = ['equirect', 'mercator', 'mollweide', 'robinson', 'winkel3'];
const INVERTIBLE = ['equirect', 'mercator', 'mollweide', 'robinson'];

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  FAIL ' + name + '\n         ' + err.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function near(actual, expected, tol, label) {
  const diff = Math.abs(actual - expected);
  if (!(diff <= tol)) {
    throw new Error(
      (label || 'value') + ': got ' + actual + ', want ' + expected +
      ' ±' + tol + ' (diff ' + diff + ')'
    );
  }
}

function finite(v, label) {
  assert(Number.isFinite(v), (label || 'value') + ' is not finite: ' + v);
}

// ── 全局：模块形状 ───────────────────────────────────────────────────────────
test('模块以 window.PROJ 暴露，且五个投影 API 齐全', () => {
  assert(PROJ && typeof PROJ === 'object', 'window.PROJ 不存在');
  assert(Object.keys(PROJ).length === 5, 'PROJ 键数量应为 5');
  for (const key of KEYS) {
    const p = PROJ[key];
    assert(p && typeof p === 'object', key + ' 缺失');
    assert(p.key === key, key + '.key 不匹配');
    assert(typeof p.name === 'string' && p.name.length > 0, key + '.name 无效');
    assert(typeof p.aspect === 'number' && Number.isFinite(p.aspect) && p.aspect > 0,
      key + '.aspect 无效');
    assert(typeof p.f === 'function', key + '.f 缺失');
    assert(typeof p.outline === 'function', key + '.outline 缺失');
  }
});

test('inverse 支持情况：四个有，winkel3 无', () => {
  for (const key of INVERTIBLE) {
    assert(typeof PROJ[key].inverse === 'function', key + ' 缺少 inverse');
  }
  assert(PROJ.winkel3.inverse === undefined, 'winkel3 不应提供 inverse');
});

test('aspect 数值与归一化常数一致', () => {
  near(PROJ.equirect.aspect, 0.5, 1e-15, 'equirect aspect');
  near(PROJ.mollweide.aspect, 0.5, 1e-15, 'mollweide aspect');
  near(
    PROJ.mercator.aspect,
    Math.log(Math.tan(Math.PI / 4 + (84 * Math.PI) / 360)) / Math.PI,
    1e-15,
    'mercator aspect'
  );
  near(PROJ.robinson.aspect, 1.3523 / (0.8487 * Math.PI), 1e-15, 'robinson aspect');
  near(PROJ.winkel3.aspect, Math.PI / (2 + Math.PI), 1e-15, 'winkel3 aspect');
});

// ── 五个投影的通用约束 ───────────────────────────────────────────────────────
for (const key of KEYS) {
  const p = PROJ[key];

  test(key + ' · f(0,0) = (0,0)', () => {
    const q = p.f(0, 0);
    near(q.x, 0, 1e-12, key + ' x');
    near(q.y, 0, 1e-12, key + ' y');
  });

  test(key + ' · f(0,±180).x = ±1', () => {
    near(p.f(0, 180).x, 1, 1e-6, key + ' f(0,180).x');
    near(p.f(0, -180).x, -1, 1e-6, key + ' f(0,-180).x');
    near(p.f(0, 180).y, 0, 1e-9, key + ' f(0,180).y');
  });

  test(key + ' · 赤道对称 f(lat).y = -f(-lat).y', () => {
    const lats = [-85, -80, -60, -30, -10, 10, 30, 60, 80, 85];
    const lons = [-150, -60, 0, 45, 120, 180];
    for (const lat of lats) {
      for (const lon of lons) {
        const north = p.f(lat, lon).y;
        const south = p.f(-lat, lon).y;
        near(north, -south, 1e-9, key + ' lat=' + lat + ' lon=' + lon);
      }
    }
  });

  test(key + ' · 经度反对称 f(-lon).x = -f(lon).x', () => {
    const lats = [-80, -60, -30, 0, 30, 60, 80];
    const lons = [30, 60, 90, 120, 150, 180];
    for (const lat of lats) {
      for (const lon of lons) {
        const east = p.f(lat, lon).x;
        const west = p.f(lat, -lon).x;
        near(west, -east, 1e-9, key + ' lat=' + lat + ' lon=' + lon);
      }
    }
  });

  test(key + ' · 极点 y = ±aspect（宽=2 ⇒ 半高=aspect）', () => {
    for (const lon of [-180, -90, 0, 90, 180]) {
      near(p.f(90, lon).y, p.aspect, 1e-9, key + ' north lon=' + lon);
      near(p.f(-90, lon).y, -p.aspect, 1e-9, key + ' south lon=' + lon);
      finite(p.f(90, lon).x, key + ' pole x');
    }
  });

  test(key + ' · outline 首尾闭合、点数 > 20、点值有限', () => {
    const o = p.outline();
    assert(Array.isArray(o), 'outline 不是数组');
    assert(o.length > 20, '点数不足: ' + o.length);
    assert(Array.isArray(o[0]) && o[0].length === 2, '首点格式错误');
    assert(Array.isArray(o[o.length - 1]) && o[o.length - 1].length === 2,
      '尾点格式错误');
    assert(o[0][0] === o[o.length - 1][0] && o[0][1] === o[o.length - 1][1],
      '首尾不闭合');
    for (const pt of o) {
      finite(pt[0], key + ' outline x');
      finite(pt[1], key + ' outline y');
    }
  });

  test(key + ' · outline bbox = 2 × 2*aspect', () => {
    const o = p.outline();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const pt of o) {
      if (pt[0] < minX) minX = pt[0];
      if (pt[0] > maxX) maxX = pt[0];
      if (pt[1] < minY) minY = pt[1];
      if (pt[1] > maxY) maxY = pt[1];
    }
    const w = maxX - minX;
    const h = maxY - minY;
    near(w, 2, 1e-9, key + ' bbox width');
    near(h, 2 * p.aspect, 1e-9, key + ' bbox height');
    near((minX + maxX) / 2, 0, 1e-9, key + ' bbox center x');
    near((minY + maxY) / 2, 0, 1e-9, key + ' bbox center y');
    near(h / w, p.aspect, 1e-9, key + ' bbox height/width');
  });
}

// ── 各投影的专项校验 ─────────────────────────────────────────────────────────
test('equirect · y = lat/180（2:1 等距圆柱）', () => {
  near(PROJ.equirect.f(90, 0).y, 0.5, 1e-15, 'pole y');
  near(PROJ.equirect.f(45, 0).y, 0.25, 1e-15, '45° y');
  near(PROJ.equirect.f(45, 30).x, 1 / 6, 1e-15, '45°,30° x');
  near(PROJ.equirect.f(45, 30).y, 0.25, 1e-15, '45°,30° y');
  assert(PROJ.equirect.aspect === 0.5, 'equirect aspect 应为 0.5');
});

test('mercator · f(45,0).y = ln(1+√2)/π', () => {
  near(
    PROJ.mercator.f(45, 0).y,
    Math.log(1 + Math.SQRT2) / Math.PI,
    1e-12,
    'mercator y(45°)'
  );
});

test('mercator · 纬度截断到 ±84°', () => {
  const p = PROJ.mercator;
  near(p.f(90, 0).y, p.aspect, 1e-15, 'clamp north');
  near(p.f(84.0000001, 0).y, p.aspect, 1e-15, 'clamp just above 84');
  near(p.f(-90, 0).y, -p.aspect, 1e-15, 'clamp south');
  near(p.inverse(0, p.aspect).lat, 84, 1e-9, 'inverse of clamped y');
});

test('mollweide · 牛顿解满足 2θ + sin2θ = π sinφ', () => {
  for (const lat of [-80, -60, -40, -20, 0, 20, 40, 60, 80]) {
    const y = PROJ.mollweide.f(lat, 0).y;
    const theta = Math.asin(Math.max(-1, Math.min(1, 2 * y)));
    const residual =
      2 * theta + Math.sin(2 * theta) - Math.PI * Math.sin((lat * Math.PI) / 180);
    near(residual, 0, 1e-9, 'lat=' + lat);
  }
});

test('robinson · 5° 表值（0°/40°/45°/60°/90°）', () => {
  const p = PROJ.robinson;
  near(p.f(0, 0).y / p.aspect, 0.0000, 1e-12, 'Y(0°)');
  near(p.f(40, 0).y / p.aspect, 0.4958, 1e-12, 'Y(40°)');
  near(p.f(45, 0).y / p.aspect, 0.5571, 1e-12, 'Y(45°)');
  near(p.f(60, 0).y / p.aspect, 0.7346, 1e-12, 'Y(60°)');
  near(p.f(90, 0).y / p.aspect, 1.0000, 1e-12, 'Y(90°)');
  near(p.f(60, 180).x, 0.7986, 1e-12, 'X(60°) at lon=180');
});

test('winkel3 · 极点/边界有限且形状合理', () => {
  const p = PROJ.winkel3;
  const pole = p.f(90, 0);
  near(pole.x, 0, 1e-12, 'north pole x');
  near(pole.y, p.aspect, 1e-12, 'north pole y');

  const k = 1 + Math.PI / 2;
  const poleCorner = p.f(90, 180);
  near(poleCorner.x, 1 / k, 1e-12, 'pole corner x');
  near(poleCorner.y, p.aspect, 1e-12, 'pole corner y');

  const east = p.f(0, 180);
  near(east.x, 1, 1e-12, 'east edge x');
  near(east.y, 0, 1e-12, 'east edge y');

  const lats = [-90, -60, 0, 60, 90];
  const lons = [-180, -120, -60, 0, 60, 120, 180];
  for (const lat of lats) {
    for (const lon of lons) {
      const q = p.f(lat, lon);
      finite(q.x, 'x(' + lat + ',' + lon + ')');
      finite(q.y, 'y(' + lat + ',' + lon + ')');
    }
  }
});

// ── 反解互逆 ─────────────────────────────────────────────────────────────────
for (const key of INVERTIBLE) {
  test(key + ' · inverse 与 f 互逆（网格）', () => {
    const p = PROJ[key];
    const lats = [-80, -60, -30, 0, 30, 60, 80];
    const lons = [-170, -120, -60, -20, 0, 35, 90, 150, 179];

    for (const lat of lats) {
      for (const lon of lons) {
        const xy = p.f(lat, lon);
        const ll = p.inverse(xy.x, xy.y);
        near(ll.lat, lat, 1e-6, key + ' roundtrip lat (' + lat + ',' + lon + ')');
        near(ll.lon, lon, 1e-6, key + ' roundtrip lon (' + lat + ',' + lon + ')');

        const xy2 = p.f(ll.lat, ll.lon);
        near(xy2.x, xy.x, 1e-9, key + ' roundtrip x (' + lat + ',' + lon + ')');
        near(xy2.y, xy.y, 1e-9, key + ' roundtrip y (' + lat + ',' + lon + ')');
      }
    }
  });
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────
const total = passed + failures.length;
console.log('\n' + passed + ' passed, ' + failures.length + ' failed, ' + total + ' total');

if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f.name + ': ' + f.err.message);
  process.exitCode = 1;
}
