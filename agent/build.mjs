// 打包 sidecar：把 pi 依赖树内联成单文件（安装包的 resources 目录没有 node_modules）。
// node 内置模块保持 external（目标机器的 node 自带）；产出到 agent/dist/，
// 由 tauri.conf.json 的 bundle.resources 映射为资源目录下的 agent/deck-agent.mjs。
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

const result = await build({
  entryPoints: ["agent/deck-agent.mjs"],
  outfile: "agent/dist/deck-agent.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  metafile: true,
  // CJS 依赖在运行时 require 内置模块：ESM 输出没有 require，注入 createRequire 顶上
  banner: {
    js: `import { createRequire as __deckCreateRequire } from "node:module"; const require = __deckCreateRequire(import.meta.url);`,
  },
});
await build({
  entryPoints: ["agent/native-harness.mjs"],
  outfile: "agent/dist/native-harness.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  logLevel: "info",
});
await build({
  entryPoints: ["scripts/runnerctl.mjs"],
  outfile: "agent/dist/runnerctl.mjs",
  bundle: true, platform: "node", format: "esm", target: "node20", logLevel: "info",
});

// photon 的 wasm：图片缩放（ImageContent → 模型可读）运行时按 execDir/photon/ 回退查找，
// 打包安装后落在资源目录的 photon/ 下即可命中
import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const wasmPath = req.resolve("@silvia-odwyer/photon-node/photon_rs_bg.wasm");
mkdirSync("agent/dist/photon", { recursive: true });
copyFileSync(wasmPath, "agent/dist/photon/photon_rs_bg.wasm");

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`sidecar bundled: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
