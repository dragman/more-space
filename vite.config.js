import { defineConfig } from "vite";
import { resolve } from "path";
import { readdirSync } from "fs";

const htmlInputs = readdirSync(resolve(__dirname, "www"))
  .filter((f) => f.endsWith(".html"))
  .reduce((acc, file) => {
    const name = file.replace(/\.html$/, "");
    acc[name] = resolve(__dirname, "www", file);
    return acc;
  }, {});

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
    rollupOptions: {
      input: htmlInputs,
    },
  },
  server: {
    fs: {
      allow: [resolve(__dirname)],
    },
  },
});
