import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

// Preserve the notices for the bundled USB/ADB runtime dependencies.
const usbPackages = ["adb", "adb-credential-web", "adb-daemon-webusb", "async", "event", "no-data-view", "stream-extra", "struct"];
const notices = await Promise.all(usbPackages.map(async (name) => {
  const directory = resolve(root, "node_modules/@yume-chan", name);
  const metadata = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
  return `@yume-chan/${name} ${metadata.version}\n\n${await readFile(resolve(directory, "LICENSE"), "utf8")}`;
}));
await writeFile(resolve(output, "THIRD_PARTY_NOTICES.txt"), notices.join("\n\n"));
