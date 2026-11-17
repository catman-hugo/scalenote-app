// Tests for the star history chart script. They call the real functions in
// scripts/star-history.mjs; no network is used.
import test from "node:test";
import assert from "node:assert/strict";
import { checkWeeks, weeklyTotals, niceStep, renderSvg } from "../scripts/star-history.mjs";

const DAY = 86400;
const week = (n) => 1_790_000_000 + n * 7 * DAY;

test("weekly counts become stars so far, oldest week first, whatever the order", () => {
  const newestFirst = [
    { week: week(2), total: 5, days: [] },
    { week: week(1), total: 0, days: [] },
    { week: week(0), total: 3, days: [] },
  ];
  assert.deepEqual(weeklyTotals(newestFirst), [
    { week: week(0), stars: 3 },
    { week: week(1), stars: 3 },
    { week: week(2), stars: 8 },
  ]);
  // The same weeks the other way round give the same result.
  assert.deepEqual(weeklyTotals([...newestFirst].reverse()), weeklyTotals(newestFirst));
});

test("a week that appears twice counts once", () => {
  const twice = [
    { week: week(0), total: 4 },
    { week: week(0), total: 4 },
  ];
  assert.deepEqual(weeklyTotals(twice), [{ week: week(0), stars: 4 }]);
});

test("a repository with no stars gives a flat line at zero", () => {
  const points = weeklyTotals([{ week: week(1), total: 0 }, { week: week(0), total: 0 }]);
  assert.deepEqual(points.map((p) => p.stars), [0, 0]);
});

test("bad answers are refused", () => {
  assert.throws(() => checkWeeks({ message: "Requires authentication" }));
  assert.throws(() => checkWeeks([{ week: "x", total: 1 }]));
  assert.throws(() => checkWeeks([{ week: week(0), total: -1 }]));
  assert.throws(() => checkWeeks([{ week: week(0), total: 1.5 }]));
  assert.throws(() => checkWeeks([null]));
  assert.deepEqual(checkWeeks([]), []);
});

test("the axis step is a round number and four steps reach the highest value", () => {
  for (const highest of [0, 1, 4, 5, 9, 17, 40, 99, 100, 101, 1234, 99999]) {
    const step = niceStep(highest);
    assert.ok(step * 4 >= highest, `${highest} fits`);
    assert.match(String(step), /^[125]0*$/, `${step} is 1, 2 or 5 times a power of ten`);
  }
});

test("the chart is a flat svg with no gradient, filter, script or outside link", () => {
  const points = weeklyTotals([
    { week: week(0), total: 2 },
    { week: week(1), total: 7 },
    { week: week(2), total: 0 },
  ]);
  for (const theme of ["light", "dark"]) {
    const svg = renderSvg(points, theme);
    assert.ok(svg.startsWith("<svg "));
    assert.ok(svg.trimEnd().endsWith("</svg>"));
    assert.match(svg, /9 stars/);
    assert.match(svg, /<polyline /);
    assert.doesNotMatch(svg, /gradient|filter|<script|href=|xlink|<image|url\(/i);
  }
  assert.notEqual(renderSvg(points, "light"), renderSvg(points, "dark"));
});

test("a chart with no data, one week and zero stars still draws", () => {
  assert.match(renderSvg([], "light"), /No data yet/);
  const one = renderSvg(weeklyTotals([{ week: week(0), total: 1 }]), "dark");
  assert.match(one, /1 star</);
  assert.match(one, /<circle /);
  const zero = renderSvg(weeklyTotals([{ week: week(0), total: 0 }, { week: week(1), total: 0 }]), "light");
  assert.match(zero, /0 stars/);
});

test("an unknown theme is refused", () => {
  assert.throws(() => renderSvg([], "purple"));
});

test("the highest star count stays inside the picture", () => {
  const svg = renderSvg(weeklyTotals([{ week: week(0), total: 120000 }]), "light");
  const y = Number(svg.match(/<circle cx="[\d.]+" cy="([\d.]+)"/)[1]);
  assert.ok(y >= 0 && y <= 400);
});
