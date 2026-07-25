import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { slidesManifest, slidesQualityReport, slidesToPptx } from "../server/dist/pptx.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(process.argv[2] || join(root, "docs/benchmarks/aiteam-helio-quality-deck.md"));
const outDir = resolve(process.argv[3] || join(root, "output/quality-benchmark"));
const content = await readFile(source, "utf8");
const quality = slidesQualityReport(content);
const manifest = slidesManifest(content);

if (quality.status !== "pass") {
  throw new Error(`演示结构门禁未通过：${quality.issues.join("；")}`);
}

await mkdir(outDir, { recursive: true });
const stem = basename(source).replace(/\.[^.]+$/, "");
const pptxPath = join(outDir, `${stem}.pptx`);
const reportPath = join(outDir, `${stem}.quality.json`);
const pptx = await slidesToPptx({ id: `benchmark-${Date.now()}`, title: "AITeam × Helio 产品升级", kind: "slides", content });

await Promise.all([
  writeFile(pptxPath, pptx),
  writeFile(reportPath, JSON.stringify({ source, pptxPath, manifest, quality }, null, 2)),
]);

console.log(JSON.stringify({ pptxPath, reportPath, bytes: pptx.length, manifest, quality }, null, 2));
