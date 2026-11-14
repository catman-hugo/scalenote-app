// One icon set: plain 1.5px outlines on a 16px grid. Icons are decoration only, so they
// are hidden from screen readers; every button also has a text label.
const paths = {
  menu: "M2 4h12M2 8h12M2 12h12",
  plus: "M8 3v10M3 8h10",
  folder: "M2 4.5h4l1.5 1.5H14v6.5H2z",
  // A book with a spiral binding down the left side.
  notebook: "M5 2.5h8v11H5zM2.5 5h5M2.5 8h5M2.5 11h5",
  // A short upright bar, like the tab of a OneNote section. It is drawn filled.
  bar: "M6.25 3.25h3.5v9.5h-3.5z",
  note: "M4 2h5l3 3v9H4zM9 2v3h3",
  check: "M3 8.5l3.5 3.5L13 4.5",
  chevronRight: "M6 3l5 5-5 5",
  chevronDown: "M3 6l5 5 5-5",
  close: "M4 4l8 8M12 4l-8 8",
  chevronUp: "M3 10l5-5 5 5",
  settings: "M6.54 3.22 6.78 1.11 9.22 1.11 9.46 3.22 10.35 3.59 12.02 2.27 13.73 3.98 12.41 5.65 12.78 6.54 14.89 6.78 14.89 9.22 12.78 9.46 12.41 10.35 13.73 12.02 12.02 13.73 10.35 12.41 9.46 12.78 9.22 14.89 6.78 14.89 6.54 12.78 5.65 12.41 3.98 13.73 2.27 12.02 3.59 10.35 3.22 9.46 1.11 9.22 1.11 6.78 3.22 6.54 3.59 5.65 2.27 3.98 3.98 2.27 5.65 3.59zM8 5.6a2.4 2.4 0 1 0 0 4.8a2.4 2.4 0 1 0 0-4.8z",
  // Six dots: a zero-length line with round ends draws one dot.
  grip: "M6 3.5h.01M10 3.5h.01M6 8h.01M10 8h.01M6 12.5h.01M10 12.5h.01",
  search: "M7 2.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9zM10.4 10.4L14 14",
  trash: "M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.5 6.5v4.5M9.5 6.5v4.5",
  image: "M2.5 3h11v10h-11zM2.5 11l3.5-3.5 3 3 2-2 2.5 2.5M10.5 6h.01",
  star: "M8 2l1.85 3.75 4.15.6-3 2.9.7 4.1L8 11.4l-3.7 1.95.7-4.1-3-2.9 4.15-.6z",
  clock: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5v3.2l2.2 1.3",
  tag: "M2.5 2.5h5.5l6 6-5.5 5.5-6-6zM5.5 5.5h.01",
  pen: "M3 13l.7-3.2L11 2.5l2.5 2.5-7.3 7.3zM9.6 3.9l2.5 2.5",
  eraser: "M2.5 10.5l6.5-7 4.5 4.5-5.5 6H5zM6 7l4.5 4.5",
  hand: "M5.5 8.5V3.8a1 1 0 0 1 2 0V8M7.5 7.5V2.8a1 1 0 0 1 2 0V8M9.5 7.5V4a1 1 0 0 1 2 0v5.5c0 2.5-1.6 4-4 4s-3.2-1-4.2-3L2.6 8.6a1 1 0 0 1 1.8-.8l1.1 1.5",
  code: "M5.5 4L2 8l3.5 4M10.5 4L14 8l-3.5 4",
  more: "M3.5 8h.01M8 8h.01M12.5 8h.01",
  lasso: "M8 3c-3 0-5.5 1.3-5.5 3s2.5 3 5.5 3 5.5-1.3 5.5-3S11 3 8 3zM6.5 9.2c-.6 1.6-.1 3.2 1.4 4",
  highlighter: "M9.5 2.5l4 4-5 5-4-4zM4.5 7.5l-1 3.5 3.5-1M3 13.5h6",
  line: "M3 13L13 3",
  arrow: "M3 13L13 3M7 3h6v6",
  rectangle: "M2.5 4h11v8h-11z",
  ellipse: "M8 3.5c3.3 0 5.5 1.9 5.5 4.5S11.3 12.5 8 12.5 2.5 10.1 2.5 8 4.7 3.5 8 3.5z",
  sticky: "M3 2.5h10v7l-4 4H3zM13 9.5H9v4",
  paper: "M3 2.5h10v11H3zM3 6.5h10M3 9.5h10M6 2.5v11",
  undo: "M5.5 3.5l-3 3 3 3M2.5 6.5h6.5a3.5 3.5 0 0 1 0 7H6",
  redo: "M10.5 3.5l3 3-3 3M13.5 6.5H7a3.5 3.5 0 0 0 0 7h3",
  folderOpen: "M2 13V4.5h4L7.5 6H12v2M2 13l2-5h11l-2 5z",
};

export function icon(name, { filled = false } = {}) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", paths[name]);
  path.setAttribute("fill", filled ? "currentColor" : "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}
