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
