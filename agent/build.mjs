// 打包 sidecar：把 pi 依赖树内联成单文件（安装包的 resources 目录没有 node_modules）。
// node 内置模块保持 external（目标机器的 node 自带）；产出到 agent/dist/，
// 由 tauri.conf.json 的 bundle.resources 映射为资源目录下的 agent/deck-agent.mjs。
import { build } from "esbuild";

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

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`sidecar bundled: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
