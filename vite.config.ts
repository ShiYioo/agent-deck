import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri 期望固定的端口，前端构建产物输出到 ../dist 供 src-tauri 打包
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // Cargo 把编译产物写进 src-tauri/target；Windows 下 vite 监听其中的 .exe
      // 会抛 EBUSY 并直接终止 dev server，导致 tauri dev 的 beforeDevCommand 失败。
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    outDir: "dist",
    target: "chrome105",
  },
});
