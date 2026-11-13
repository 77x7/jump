import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  // Content scripts must be single-file IIFEs, so each gets its own build pass.
  // The service worker is one too: Chrome starts it for most opens (it stops
  // it after 30 s idle), and one classic script starts faster than a module
  // that has to fetch its imported chunks.
  const contentEntries: Partial<Record<string, { input: string; output: string }>> = {
    content: { input: "src/content.tsx", output: "assets/content.js" },
    keyguard: { input: "src/keyGuard.ts", output: "assets/keyguard.js" },
    background: { input: "src/background.ts", output: "assets/background.js" },
  };
  const contentEntry = contentEntries[mode];
  const contentBuild = contentEntry !== undefined;

  return {
  // Preact runs the React code unchanged and is far lighter: the in-page
  // palette is injected on first open, and React's ~200 KB took ~28 ms to
  // load and compile there.
  resolve: {
    alias: [
      { find: /^react-dom\/client$/, replacement: "preact/compat/client" },
      { find: /^react\/jsx-runtime$/, replacement: "preact/jsx-runtime" },
      { find: /^react\/jsx-dev-runtime$/, replacement: "preact/jsx-dev-runtime" },
      { find: /^react-dom$/, replacement: "preact/compat" },
      { find: /^react$/, replacement: "preact/compat" },
    ],
  },
  plugins: [
    react(),
    {
      name: "copy-extension-assets",
      closeBundle() {
        if (contentBuild) return;
        const outputDir = resolve(projectRoot, "dist");
        mkdirSync(outputDir, { recursive: true });
        copyFileSync(resolve(projectRoot, "manifest.json"), resolve(outputDir, "manifest.json"));
      },
    },
  ],
  build: {
    outDir: "dist",
    emptyOutDir: !contentBuild,
    modulePreload: false,
    rollupOptions: {
      input: contentBuild ? resolve(projectRoot, contentEntry.input) : {
        app: resolve(projectRoot, "index.html"),
        popup: resolve(projectRoot, "popup.html"),
        palette: resolve(projectRoot, "palette.html"),
      },
      output: contentBuild ? {
        format: "iife",
        inlineDynamicImports: true,
        entryFileNames: contentEntry.output,
      } : {
        entryFileNames: "assets/[name].js",
      },
    },
  },
  };
});
