// One icon set: plain 1.5px outlines on a 16px grid. Icons are decoration only, so they
// are hidden from screen readers; every button also has a text label.
const paths = {
  menu: "M2 4h12M2 8h12M2 12h12",
  plus: "M8 3v10M3 8h10",
  folder: "M2 4.5h4l1.5 1.5H14v6.5H2z",
  note: "M4 2h5l3 3v9H4zM9 2v3h3",
  check: "M3 8.5l3.5 3.5L13 4.5",
  chevronRight: "M6 3l5 5-5 5",
  chevronDown: "M3 6l5 5 5-5",
  settings: "M6.54 3.22 6.78 1.11 9.22 1.11 9.46 3.22 10.35 3.59 12.02 2.27 13.73 3.98 12.41 5.65 12.78 6.54 14.89 6.78 14.89 9.22 12.78 9.46 12.41 10.35 13.73 12.02 12.02 13.73 10.35 12.41 9.46 12.78 9.22 14.89 6.78 14.89 6.54 12.78 5.65 12.41 3.98 13.73 2.27 12.02 3.59 10.35 3.22 9.46 1.11 9.22 1.11 6.78 3.22 6.54 3.59 5.65 2.27 3.98 3.98 2.27 5.65 3.59zM8 5.6a2.4 2.4 0 1 0 0 4.8a2.4 2.4 0 1 0 0-4.8z",
  // Six dots: a zero-length line with round ends draws one dot.
  grip: "M6 3.5h.01M10 3.5h.01M6 8h.01M10 8h.01M6 12.5h.01M10 12.5h.01",
  search: "M7 2.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9zM10.4 10.4L14 14",
  trash: "M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.5 6.5v4.5M9.5 6.5v4.5",
  image: "M2.5 3h11v10h-11zM2.5 11l3.5-3.5 3 3 2-2 2.5 2.5M10.5 6h.01",
  folderOpen: "M2 13V4.5h4L7.5 6H12v2M2 13l2-5h11l-2 5z",
};

export function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", paths[name]);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}
