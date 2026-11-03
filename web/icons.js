// One icon set: plain 1.5px outlines on a 16px grid. Icons are decoration only, so they
// are hidden from screen readers; every button also has a text label.
const paths = {
  menu: "M2 4h12M2 8h12M2 12h12",
  plus: "M8 3v10M3 8h10",
  folder: "M2 4.5h4l1.5 1.5H14v6.5H2z",
  note: "M4 2h5l3 3v9H4zM9 2v3h3",
  chevronRight: "M6 3l5 5-5 5",
  chevronDown: "M3 6l5 5 5-5",
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
