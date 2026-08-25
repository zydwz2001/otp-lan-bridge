import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

await build({
  entryPoints: {
    background: resolve(root, "src/background.ts"),
    content: resolve(root, "src/content.ts"),
    "pair-permission": resolve(root, "src/pair-permission.ts")
  },
  bundle: true,
  outdir: output,
  format: "esm",
  target: "chrome116",
  sourcemap: false,
  minify: false,
  logLevel: "info"
});

await Promise.all([
  cp(resolve(root, "src/manifest.json"), resolve(output, "manifest.json")),
  cp(resolve(root, "src/pair-permission.html"), resolve(output, "pair-permission.html")),
  cp(resolve(root, "src/pair-permission.css"), resolve(output, "pair-permission.css"))
]);
