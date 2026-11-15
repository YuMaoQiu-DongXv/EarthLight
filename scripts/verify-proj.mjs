/*
 * 独立验收脚本：不信任 src/projections.test.mjs，用外部契约检查一遍。
 * 用法：node scripts/verify-proj.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const code = readFileSync(resolve(root, "src/projections.js"), "utf8");

const sandbox = { window: {}, Math, console };
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "projections.js" });

const PROJ = sandbox.window.PROJ;
if (!PROJ) {
  console.error("FAIL: window.PROJ 未定义");
  process.exit(1);
}

const keys = ["equirect", "mercator", "mollweide", "robinson", "winkel3"];
let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { fails++; console.log("  FAIL " + msg); }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

console.log("投影数量:", Object.keys(PROJ).join(", "));

for (const k of keys) {
  const p = PROJ[k];
  if (!p) { console.log(`\n[${k}] 缺失`); fails++; continue; }
  console.log(`\n[${k}] ${p.name || ""} aspect=${p.aspect}`);
  ok(typeof p.f === "function", "f 不是函数");
  ok(typeof p.aspect === "number" && p.aspect > 0 && p.aspect < 2, "aspect 不合理: " + p.aspect);

  const o = p.f(0, 0);
  ok(near(o.x, 0, 1e-9) && near(o.y, 0, 1e-9), `f(0,0)=(${o.x},${o.y}) 不是原点`);

  const e = p.f(0, 180);
  ok(near(Math.abs(e.x), 1, 1e-6), `f(0,180).x=${e.x} 不等于 ±1`);
  const w = p.f(0, -180);
  ok(near(e.x, -w.x, 1e-9), "东西不对称");

  // 赤道对称 / 经度反对称
  for (const [lat, lon] of [[30, 45], [-60, 120], [75, -150]]) {
    const a = p.f(lat, lon), b = p.f(-lat, lon), c = p.f(lat, -lon);
    ok(near(a.y, -b.y, 1e-9), `赤道不对称 lat=${lat}`);
    ok(near(a.x, -c.x, 1e-9), `经度反对称失败 lat=${lat} lon=${lon}`);
  }

  // 极点应到边缘（y = ±aspect）
  const np = p.f(90, 0), sp = p.f(-90, 0);
  ok(isFinite(np.y) && isFinite(sp.y), "极点 y 非有限值");
  ok(near(np.y, -sp.y, 1e-6), "南北极不对称");
  ok(near(Math.abs(np.y), p.aspect, 1e-6), `极点 |y|=${Math.abs(np.y)} 应等于 aspect=${p.aspect}`);

  // 单调性：沿赤道 x 随经度单调增
  let prev = -Infinity, mono = true;
  for (let lon = -180; lon <= 180; lon += 10) {
    const x = p.f(0, lon).x;
    if (x < prev - 1e-9) mono = false;
    prev = x;
  }
  ok(mono, "赤道 x 不单调");

  // outline
  if (typeof p.outline === "function") {
    const ol = p.outline();
    ok(Array.isArray(ol) && ol.length >= 4, `outline 点数 ${ol && ol.length}`);
    const first = ol[0], last = ol[ol.length - 1];
    ok(near(first[0], last[0], 1e-6) && near(first[1], last[1], 1e-6), "outline 未闭合");
    const ys = ol.map(q => q[1]);
    ok(near(Math.max(...ys), p.aspect, 1e-6), `outline 上沿 ${Math.max(...ys)} ≠ aspect`);
    ok(near(Math.min(...ys), -p.aspect, 1e-6), `outline 下沿 ${Math.min(...ys)} ≠ -aspect`);
    const xs = ol.map(q => q[0]);
    ok(near(Math.max(...xs), 1, 1e-6) && near(Math.min(...xs), -1, 1e-6), "outline 左右不是 ±1");
  } else {
    fails++; console.log("  FAIL 缺 outline()");
  }

  // inverse 互逆（可选）
  if (typeof p.inverse === "function") {
    let worst = 0;
    for (const [lat, lon] of [[0, 0], [23.44, 60], [-45, -120], [66, 170], [-80, 20]]) {
      const q = p.f(lat, lon);
      const r = p.inverse(q.x, q.y);
      worst = Math.max(worst, Math.abs(r.lat - lat), Math.abs(((r.lon - lon + 540) % 360) - 180));
    }
    ok(worst < 1e-4, `inverse 互逆误差 ${worst}`);
    console.log("  inverse 最大误差:", worst.toExponential(2));
  }
}

console.log(fails === 0 ? "\n✅ 外部契约检查全部通过" : `\n❌ ${fails} 项未通过`);
process.exit(fails === 0 ? 0 : 1);

