import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  base: "/more-space/",
  root: "www",
  publicDir: resolve(__dirname, "pkg"),
  resolve: {
    alias: {
      "/pkg": resolve(__dirname, "pkg"),
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    fs: {
      allow: [resolve(__dirname)],
    },
  },
});
