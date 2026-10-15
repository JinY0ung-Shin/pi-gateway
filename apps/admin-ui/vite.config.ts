import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// 빌드 결과는 gateway가 /admin에서 서빙한다 (apps/gateway/public/admin).
export default defineConfig({
  plugins: [preact()],
  base: "/admin/",
  build: {
    outDir: "../gateway/public/admin",
    emptyOutDir: true,
    assetsDir: "assets",
    sourcemap: false,
  },
  server: {
    proxy: { "/admin/api": "http://localhost:8080" },
  },
});
