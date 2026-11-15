/*
 * 把 src/projections.js 与 src/coast.js 内联进 index.html 的标记区。
 * 用法：node scripts/inline.mjs
 * 目的：仓库里保留可维护的源文件，交付物仍是"单文件、双击即用"的 index.html。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = resolve(root, "index.html");

const targets = [
  { name: "projections", file: resolve(root, "src/projections.js") },
  { name: "coast", file: resolve(root, "src/coast.js") },
];

let html = readFileSync(HTML, "utf8");
const report = [];

for (const t of targets) {
  let src;
  try {
    src = readFileSync(t.file, "utf8");
  } catch {
    report.push(`跳过 ${t.name}（找不到 ${t.file}）`);
    continue;
  }
  const start = `<!-- BUILD:${t.name}:start -->`;
  const end = `<!-- BUILD:${t.name}:end -->`;
  const i = html.indexOf(start);
  const j = html.indexOf(end);
  if (i < 0 || j < 0) {
    report.push(`跳过 ${t.name}（index.html 里缺标记）`);
    continue;
  }
  const payload = `<script>\n/* ${t.name} · 自动注入，改源文件请编辑 src/ 后重跑 scripts/inline.mjs */\n${src}\n</script>`;
  html = html.slice(0, i + start.length) + "\n" + payload + "\n" + html.slice(j);
  report.push(`注入 ${t.name} ← ${t.file.replace(root + "\\", "")} (${(src.length / 1024).toFixed(1)} KB)`);
}

writeFileSync(HTML, html, "utf8");
console.log(report.join("\n"));
console.log(`index.html 现在 ${(readFileSync(HTML, "utf8").length / 1024).toFixed(1)} KB`);
