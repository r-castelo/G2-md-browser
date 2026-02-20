import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    target: "es2019",
    outDir: "dist",
    sourcemap: false,
    minify: true,
    rollupOptions: {
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name].[ext]",
      },
    },
  },
  server: {
    host: true,
  },
});
