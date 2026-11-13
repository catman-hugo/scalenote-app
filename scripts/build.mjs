// Builds the interface into dist/, which the app window loads.
// Run with: npm run build

import { build } from "esbuild";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.join(root, "web");
const dist = path.join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// The version and this version's release notes are built into the interface, so the update
// check knows what it is running and the "What's new" screen needs no network.
const version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
const notes = await readFile(path.join(root, "docs", "release-notes", `${version}.md`), "utf8").catch(() => "");

// Two bundles: the notes screen and the pen test page.
await build({
  entryPoints: [path.join(web, "main.js"), path.join(web, "pentest.js")],
  outdir: dist,
  bundle: true,
  format: "esm",
  // pdf.js is loaded with import() the first time a PDF is used, so it becomes its own file
  // and a vault without PDFs never loads it.
  splitting: true,
  target: ["es2022", "chrome105", "safari15"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
  define: { __APP_VERSION__: JSON.stringify(version), __RELEASE_NOTES__: JSON.stringify(notes) },
  logLevel: "info",
});

for (const file of ["index.html", "pentest.html", "style.css", "themes.css", "pentest.css"]) {
  await cp(path.join(web, file), path.join(dist, file));
}
// A small copy of the logo (128px) for the screens; the full-size one stays in assets/.
await cp(path.join(web, "logo.png"), path.join(dist, "logo.png"));

// The worker is a module but is named .js: a webview that does not know ".mjs" would serve it
// as a plain download and the worker would not start.
// What pdf.js needs next to the app (nothing is fetched from the network): its worker, the
// standard fonts for PDFs that do not carry theirs, and the image decoders (wasm).
// The legacy build is used because it also runs in older Android webviews.
const pdfjs = path.join(root, "node_modules", "pdfjs-dist");
await mkdir(path.join(dist, "pdf"), { recursive: true });
await cp(path.join(pdfjs, "legacy", "build", "pdf.worker.min.mjs"), path.join(dist, "pdf", "pdf.worker.min.js"));
await cp(path.join(pdfjs, "standard_fonts"), path.join(dist, "pdf", "standard_fonts"), { recursive: true });
// Only the script versions of the image decoders are shipped (the app runs pdf.js with
// WebAssembly off), not the .wasm files and not QuickJS, which is for scripts inside PDFs.
await cp(path.join(pdfjs, "wasm"), path.join(dist, "pdf", "wasm"), {
  recursive: true,
  filter: (from) => from === path.join(pdfjs, "wasm") || /nowasm_fallback\.js$|^LICENSE/.test(path.basename(from)),
});
await cp(path.join(pdfjs, "LICENSE"), path.join(dist, "pdf", "LICENSE.txt"));
