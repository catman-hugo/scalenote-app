// Draws the "stars over time" chart for the README.
//
// Why this exists: the chart images from outside chart services did not show on the
// README page. This script asks GitHub for the number of new stars per week (an endpoint
// that needs no sign-in for a public repository) and draws two small SVG files itself,
// one light and one dark. A weekly workflow runs it and puts the files on a branch called
// `star-history-data`, which the README links to. Nothing in the app uses this script.
//
// Use: node scripts/star-history.mjs <output folder> [--input weeks.json]
//   Without --input it reads GITHUB_REPOSITORY (for example alice/example) and asks GitHub.
//   With --input it reads a saved answer instead, which is how it is tested without network.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// GitHub gives the weeks in pages of 30, newest week first.
export const PER_PAGE = 30;
// A hard stop so a wrong answer can never make this loop for ever.
export const MAX_PAGES = 100;

// Everything that comes from the network is checked before it is used.
export function checkWeeks(list) {
  if (!Array.isArray(list)) throw new Error("GitHub did not answer with a list of weeks");
  for (const w of list) {
    const ok = w && Number.isInteger(w.week) && Number.isInteger(w.total) && w.total >= 0;
    if (!ok) throw new Error("An entry in the answer is not a week with a star count");
  }
  return list;
}

// Turns "new stars in each week" into "stars so far at each week", oldest week first.
// The order of the input is not trusted, and a week that appears twice counts once.
export function weeklyTotals(weeks) {
  const byWeek = new Map();
  for (const w of checkWeeks(weeks)) byWeek.set(w.week, w.total);
  let stars = 0;
  return [...byWeek.keys()]
    .sort((a, b) => a - b)
    .map((week) => {
      stars += byWeek.get(week);
      return { week, stars };
    });
}

// The step between two lines on the up-and-down axis: 1, 2, 5, 10, 20, 50 ... with four
// steps in all, so the axis always reaches the highest value.
export function niceStep(highest) {
  const wanted = Math.max(1, Math.ceil(highest / 4));
  const size = 10 ** Math.floor(Math.log10(wanted));
  for (const m of [1, 2, 5, 10]) if (m * size >= wanted) return m * size;
  return 10 * size;
}

const dateOf = (week) => new Date(week * 1000).toISOString().slice(0, 10);

// Flat colours only (no gradients, no glow), like the rest of the project.
const COLOURS = {
  light: { back: "#ffffff", text: "#1f2328", quiet: "#656d76", grid: "#d8dee4", line: "#1d4ed8" },
  dark: { back: "#0d1117", text: "#e6edf3", quiet: "#8d96a0", grid: "#30363d", line: "#58a6ff" },
};

const escapeText = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

// Draws the chart as one SVG text. `points` comes from weeklyTotals.
export function renderSvg(points, theme = "light") {
  const c = COLOURS[theme];
  if (!c) throw new Error("The theme must be light or dark");
  const W = 800;
  const H = 400;
  const left = 64;
  const right = 28;
  const top = 72;
  const bottom = 56;
  const plotW = W - left - right;
  const plotH = H - top - bottom;

  const total = points.length ? points[points.length - 1].stars : 0;
  const step = niceStep(total);
  const axisTop = step * 4;
  const x = (i) => (points.length < 2 ? left + plotW / 2 : left + (i * plotW) / (points.length - 1));
  const y = (stars) => top + plotH * (1 - stars / axisTop);

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">`);
  parts.push(`<title>Stars over time</title>`);
  parts.push(`<rect width="${W}" height="${H}" fill="${c.back}"/>`);
  parts.push(`<text x="${left}" y="38" font-family="sans-serif" font-size="20" font-weight="600" fill="${c.text}">Stars over time</text>`);
  parts.push(
    `<text x="${W - right}" y="38" text-anchor="end" font-family="sans-serif" font-size="16" fill="${c.quiet}">${escapeText(total)} ${total === 1 ? "star" : "stars"}</text>`,
  );

  // Grid lines and the numbers beside them.
  for (let n = 0; n <= 4; n++) {
    const value = n * step;
    const gy = y(value).toFixed(1);
    parts.push(`<line x1="${left}" y1="${gy}" x2="${W - right}" y2="${gy}" stroke="${c.grid}" stroke-width="1"/>`);
    parts.push(
      `<text x="${left - 10}" y="${(Number(gy) + 4).toFixed(1)}" text-anchor="end" font-family="sans-serif" font-size="12" fill="${c.quiet}">${value}</text>`,
    );
  }

  if (points.length === 0) {
    parts.push(
      `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-family="sans-serif" font-size="14" fill="${c.quiet}">No data yet</text>`,
    );
  } else {
    // First and last date under the chart.
    const first = escapeText(dateOf(points[0].week));
    const last = escapeText(dateOf(points[points.length - 1].week));
    if (points.length === 1) {
      parts.push(`<text x="${x(0)}" y="${H - 22}" text-anchor="middle" font-family="sans-serif" font-size="12" fill="${c.quiet}">${first}</text>`);
    } else {
      parts.push(`<text x="${left}" y="${H - 22}" text-anchor="start" font-family="sans-serif" font-size="12" fill="${c.quiet}">${first}</text>`);
      parts.push(`<text x="${W - right}" y="${H - 22}" text-anchor="end" font-family="sans-serif" font-size="12" fill="${c.quiet}">${last}</text>`);
    }
    if (points.length > 1) {
      const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.stars).toFixed(1)}`).join(" ");
      parts.push(`<polyline points="${line}" fill="none" stroke="${c.line}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`);
    }
    parts.push(`<circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(total).toFixed(1)}" r="4" fill="${c.line}"/>`);
  }
  parts.push(`</svg>`);
  return parts.join("\n") + "\n";
}

// Asks GitHub for every page of weeks. Stops when a page is short, empty or a repeat.
export async function fetchWeeks(repo, token) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "")) throw new Error("GITHUB_REPOSITORY must look like owner/name");
  const all = [];
  let previousFirst = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://api.github.com/repos/${repo}/stargazers/history?per_page=${PER_PAGE}&page=${page}`;
    const headers = { Accept: "application/vnd.github+json", "User-Agent": "scalenote-star-history" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for page ${page}`);
    const list = checkWeeks(await res.json());
    if (list.length === 0) break;
    // If the server ignores the page number it sends the same page again; stop instead of looping.
    if (previousFirst === list[0].week) break;
    previousFirst = list[0].week;
    all.push(...list);
    if (list.length < PER_PAGE) break;
  }
  return all;
}

async function main(argv) {
  const outDir = argv[0];
  if (!outDir) throw new Error("Usage: node scripts/star-history.mjs <output folder> [--input weeks.json]");
  const inputAt = argv.indexOf("--input");
  const weeks =
    inputAt >= 0
      ? JSON.parse(await readFile(argv[inputAt + 1], "utf8"))
      : await fetchWeeks(process.env.GITHUB_REPOSITORY, process.env.GITHUB_TOKEN);
  const points = weeklyTotals(weeks);
  await mkdir(outDir, { recursive: true });
  for (const theme of ["light", "dark"]) {
    await writeFile(path.join(outDir, `star-history-${theme}.svg`), renderSvg(points, theme));
  }
  console.log(`Wrote the light and dark chart to ${outDir}: ${points.length} weeks, ${points.length ? points[points.length - 1].stars : 0} stars.`);
}

// Only run when started from the command line, so the tests can import the functions.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
