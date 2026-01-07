import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  base: "/more-space/",
  root: "www",
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
