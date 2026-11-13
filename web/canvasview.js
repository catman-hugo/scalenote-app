// The canvas of a page: a sheet you draw on with a pen, highlighter, shapes and sticky notes,
// erase from, select with a loop, and move around.
//
// This file draws and listens; what an item is and how it is stored is in canvasrules.js, and
// saving is done by main.js (this view only says "something changed").
//
// Input rules, and why:
// - A pen or a mouse draws. A finger moves the sheet (one finger) or zooms it (two), so a hand
//   resting on the screen never leaves a mark. "Finger draws" in the toolbar turns that around
//   for a device that has no pen.
// - A pen's eraser end erases for as long as it is held. The barrel button does what the
//   "Pen button" setting says: erase (the default), select with a loop, or nothing.
// - Everything is stored in canvas units, so zooming only changes how it is drawn.
import {
  DrawingHistory, LIMITS, MARGIN_X, NOTE, PAGE_COLOURS, PAPERS, PEN_COLOURS, PEN_WIDTHS, SHAPES, nearestWidthStop, snapToGrid,
  arrowHead, boundsOf, boxOf, canAddItem, canMove, drawnWidth, ellipseOutline, emptyCanvas, tidyStroke,
  itemsInLoop, itemsTouched, moveAnchor, moveItem, noteTextHeight, pageFill, paperInks, paperLayout, snappedShift, widthAt, wrapText,
  frameHit,
  draggedFrame,
  FRAME_LIMITS,
} from "./canvasrules.js";
import { createPainter, readEnv } from "./canvaspaint.js";
import { icon } from "./icons.js";
import { strings } from "./strings.js";

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
// The eraser is this many screen pixels wide, whatever the zoom.
const ERASER_PIXELS = 10;
// A new point closer than this many screen pixels to the last one adds nothing visible.
const MIN_STEP_PIXELS = 0.8;
// A shape dragged less than this many screen pixels is a stray tap, not a shape.
const MIN_SHAPE_PIXELS = 4;
// A note drawn smaller than this on the screen is a stray tap, not a box.
const NOTE_MIN_PIXELS = 24;
// How far outside the selection box a press still counts as being on it.
const GRAB_PIXELS = 8;
// How close to the resize handle counts as holding it. Bigger than it looks, for a finger or a pen.
const HANDLE_PIXELS = 16;
// Tools that choose how the next thing is drawn, so picking a colour or width switches to the pen
// only when the current tool has no colour of its own.
const COLOURLESS_TOOLS = ["eraser", "hand", "select"];

const TOOL_ICONS = {
  select: "lasso", pen: "pen", highlighter: "highlighter", eraser: "eraser", hand: "hand",
  line: "line", arrow: "arrow", rect: "rectangle", ellipse: "ellipse", note: "sticky",
};

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toggleButton(label, onClick) {
  const button = make("button", "canvas-tool");
  button.type = "button";
  button.setAttribute("aria-pressed", "false");
  button.title = label;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", onClick);
  return button;
}

function plainButton(label, iconName, onClick) {
  const button = make("button", "canvas-tool");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(icon(iconName));
  button.addEventListener("click", onClick);
  return button;
}

const SVG = "http://www.w3.org/2000/svg";
// A small picture of a paper for its button in the paper menu: the lines at the spacing that
// paper really has, scaled down, and the red margin line for rule lines.
function paperThumb(paper) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 40 28");
  svg.setAttribute("width", "40");
  svg.setAttribute("height", "28");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "paper-thumb");
  const layout = paperLayout(paper);
  const line = (x1, y1, x2, y2, cls) => {
    const node = document.createElementNS(SVG, "line");
    node.setAttribute("x1", x1);
    node.setAttribute("y1", y1);
    node.setAttribute("x2", x2);
    node.setAttribute("y2", y2);
    node.setAttribute("class", cls);
    svg.append(node);
  };
  if (layout) {
    const gap = layout.step / 6;
    for (let at = gap; at < 28; at += gap) line(0, at, 40, at, "paper-line");
    if (layout.kind === "grid") for (let at = gap; at < 40; at += gap) line(at, 0, at, 28, "paper-line");
    else line(7, 0, 7, 28, "paper-margin");
  }
  return svg;
}

/**
 * Builds the canvas inside `host`. `onChange()` is called after every finished gesture,
 * `onNotice(text)` for a short message (for example, the drawing is full), and `penButton()`
 * says what the barrel button of a pen does: "erase", "select" or "none". `snapShapes()` says
 * whether shape corners snap to a grid.
 */
export function createCanvasView(host, { onChange, onNotice, penButton = () => "erase", snapShapes = () => true }) {
  const t = strings.canvas;
  const state = {
    canvas: emptyCanvas(),
    history: new DrawingHistory(),
    readOnly: false,
    tool: "pen",
    shape: "rect",
    colour: "ink",
    width: PEN_WIDTHS[1],
    fingerDraws: false,
    view: { x: 0, y: 0, scale: 1 },
    gesture: null,
    selection: [],
    // The frame (a region a canvas block shows) picked with the loop tool, to move, resize or delete.
    frameSel: null,
    editing: null,
    touches: new Map(),
    pinch: null,
    spaceDown: false,
    frame: 0,
    colours: {},
    pageFill: "#fff",
    wrapped: new WeakMap(),
  };

  const toolbar = make("div", "canvas-toolbar");
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", t.toolbar);
  const notice = make("p", "canvas-problem");
  notice.setAttribute("role", "status");
  notice.hidden = true;
  const stage = make("div", "canvas-stage");
  const surface = make("canvas", "canvas-surface");
  surface.tabIndex = 0;
  surface.setAttribute("aria-label", t.surface);
  stage.append(surface);
  const context = surface.getContext("2d");

  // ---- toolbar ----
  // Shapes, colours, line widths and the less used switches live in small menus that open under
  // their button, so the whole toolbar fits on one or two lines and the sheet keeps its room.
  const toolButtons = {};
  function toolButton(name) {
    const button = toggleButton(t.tools[name], () => setTool(name));
    button.dataset.tool = name;
    button.append(icon(TOOL_ICONS[name]));
    toolButtons[name] = button;
    return button;
  }

  const menus = {};
  let openMenu = null;
  function makeMenu(name, label, button, items) {
    const panel = make("div", "canvas-menu");
    panel.setAttribute("role", "group");
    panel.setAttribute("aria-label", label);
    panel.hidden = true;
    panel.dataset.menu = name;
    panel.append(...items);
    button.dataset.menu = name;
    button.setAttribute("aria-haspopup", "true");
    button.setAttribute("aria-expanded", "false");
    menus[name] = { name, button, panel };
    host.append(panel);
  }
  function closeMenu() {
    if (!openMenu) return;
    openMenu.panel.hidden = true;
    openMenu.button.setAttribute("aria-expanded", "false");
    openMenu = null;
  }
  function toggleMenu(name) {
    const wasOpen = openMenu && openMenu.name === name;
    closeMenu();
    if (wasOpen) return;
    const menu = menus[name];
    menu.panel.hidden = false;
    menu.button.setAttribute("aria-expanded", "true");
    // Under the button, kept inside the canvas area whatever the width.
    const hostBox = host.getBoundingClientRect();
    const buttonBox = menu.button.getBoundingClientRect();
    const left = Math.max(4, Math.min(buttonBox.left - hostBox.left, hostBox.width - menu.panel.offsetWidth - 4));
    menu.panel.style.left = `${left}px`;
    menu.panel.style.top = `${buttonBox.bottom - hostBox.top + 4}px`;
    openMenu = menu;
  }
  // A press anywhere outside the open menu closes it.
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (openMenu && !openMenu.panel.contains(event.target) && !openMenu.button.contains(event.target)) closeMenu();
    },
    true,
  );
  host.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && openMenu) {
      const button = openMenu.button;
      closeMenu();
      button.focus();
    }
  });

  // A button that opens a menu shows what is chosen now, and a small arrow.
  function menuButton(label, show) {
    const button = make("button", "canvas-tool canvas-menu-button");
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.show = () => {
      const arrow = icon("chevronDown");
      arrow.classList.add("canvas-arrow");
      button.replaceChildren(show(), arrow);
    };
    return button;
  }

  toolbar.append(...["select", "pen", "highlighter", "eraser", "hand"].map(toolButton));
  toolbar.append(make("span", "canvas-gap"));

  // Shapes: the button picks the shape used last and opens the others.
  const shapeButton = menuButton(t.shapes, () => icon(TOOL_ICONS[state.shape]));
  shapeButton.addEventListener("click", () => {
    if (!SHAPES.includes(state.tool)) setTool(state.shape);
    toggleMenu("shape");
  });
  makeMenu("shape", t.shapes, shapeButton, SHAPES.map(toolButton));
  toolbar.append(shapeButton, toolButton("note"), make("span", "canvas-gap"));

  const colourButtons = {};
  const colourButton = menuButton(t.colour, () => make("span", `canvas-swatch pen-${state.colour}`));
  colourButton.addEventListener("click", () => toggleMenu("colour"));
  makeMenu("colour", t.colour, colourButton, PEN_COLOURS.map((name) => {
    const button = toggleButton(t.colours[name], () => setColour(name));
    button.classList.add("canvas-colour");
    button.dataset.colour = name;
    button.append(make("span", `canvas-swatch pen-${name}`));
    colourButtons[name] = button;
    return button;
  }));

  const widthButton = menuButton(t.width, () => {
    const line = make("span", "canvas-line");
    line.dataset.size = String(nearestWidthStop(state.width));
    return line;
  });
  widthButton.addEventListener("click", () => toggleMenu("width"));
  // Five stops on a slider. The slider stays open while it is dragged, so the width can be
  // tried against the line shown under it.
  const widthSlider = make("input", "canvas-slider");
  widthSlider.type = "range";
  widthSlider.min = "0";
  widthSlider.max = String(PEN_WIDTHS.length - 1);
  widthSlider.step = "1";
  widthSlider.setAttribute("aria-label", t.width);
  const widthPreview = make("span", "canvas-line");
  widthSlider.addEventListener("input", () => setWidth(PEN_WIDTHS[Number(widthSlider.value)], true));
  makeMenu("width", t.width, widthButton, [widthPreview, widthSlider]);
  menus.width.panel.classList.add("canvas-menu-slider");
  toolbar.append(colourButton, widthButton, make("span", "canvas-gap"));

  // The paper (lines behind the drawing) and the page colour belong to the drawing, not to the app,
  // so they are saved with it and can be undone.
  const paperButton = menuButton(t.paper, () => icon("paper"));
  paperButton.addEventListener("click", () => toggleMenu("paper"));
  const paperButtons = {};
  const paperChoice = (name) => {
    const button = toggleButton(t.papers[name], () => setSetting("paper", name));
    button.classList.add("canvas-paper");
    button.dataset.paper = name;
    button.append(name === "none" ? make("span", "canvas-paper-none", t.noLines) : paperThumb(name));
    paperButtons[name] = button;
    return button;
  };
  makeMenu("paper", t.paper, paperButton, [
    make("p", "canvas-menu-heading", t.ruleLines),
    ...PAPERS.slice(0, 5).map(paperChoice),
    make("p", "canvas-menu-heading", t.gridLines),
    ...PAPERS.slice(5).map(paperChoice),
  ]);

  const pageButton = menuButton(t.pageColour, () => make("span", "canvas-page-swatch"));
  pageButton.addEventListener("click", () => {
    refreshPageSwatches();
    toggleMenu("page");
  });
  const pageButtons = {};
  const pageChoice = (name) => {
    const button = toggleButton(name === "none" ? t.noColour : t.pageNames[name], () => setSetting("page", name));
    button.classList.add(name === "none" ? "canvas-menu-row" : "canvas-page");
    button.dataset.page = name;
    if (name === "none") button.textContent = t.noColour;
    else button.append(make("span", "canvas-page-swatch"));
    pageButtons[name] = button;
    return button;
  };
  makeMenu("page", t.pageColour, pageButton, PAGE_COLOURS.slice(1).map(pageChoice).concat(pageChoice("none")));
  toolbar.append(paperButton, pageButton, make("span", "canvas-gap"));

  const undoButton = plainButton(t.undo, "undo", undo);
  const redoButton = plainButton(t.redo, "redo", redo);
  const deleteButton = plainButton(t.deleteSelection, "trash", deleteSelection);
  deleteButton.dataset.action = "delete-selection";

  const fingerButton = toggleButton(t.finger, () => {
    state.fingerDraws = !state.fingerDraws;
    drawToolbar();
  });
  fingerButton.classList.add("canvas-menu-row");
  fingerButton.textContent = t.finger;
  const resetButton = make("button", "canvas-menu-row", t.resetView);
  resetButton.type = "button";
  resetButton.addEventListener("click", () => {
    closeMenu();
    fitView();
    scheduleDraw();
  });
  const moreButton = plainButton(t.more, "more", () => toggleMenu("more"));
  makeMenu("more", t.more, moreButton, [fingerButton, resetButton]);
  // The name of the selected region. It is shown on the canvas and at the top of the block in the
  // text. The field belongs to the frame that was selected when it was filled in, so a click
  // elsewhere on the sheet (which clears the selection first) still saves the name.
  const regionName = make("input", "canvas-region-name");
  regionName.type = "text";
  regionName.maxLength = FRAME_LIMITS.label;
  regionName.placeholder = t.regionNamePlaceholder;
  regionName.setAttribute("aria-label", t.regionName);
  regionName.style.visibility = "hidden";
  let regionNamed = null;
  regionName.addEventListener("change", () => {
    const frame = regionNamed;
    if (!frame || state.readOnly || !state.canvas.frames.includes(frame)) return;
    const value = regionName.value.trim().slice(0, FRAME_LIMITS.label);
    if (value === frame.label) return;
    const before = { label: frame.label };
    frame.label = value;
    state.history.record({ frames: [{ frame, before, after: { label: value } }] });
    changed();
  });
  regionName.addEventListener("keydown", (event) => {
    if (event.key === "Enter") regionName.blur();
    if (event.key === "Escape") {
      regionName.value = regionNamed ? regionNamed.label : "";
      regionName.blur();
    }
    event.stopPropagation(); // typing a name must not trigger tool shortcuts
  });
  toolbar.append(undoButton, redoButton, deleteButton, moreButton);
  host.prepend(toolbar, notice, stage);
  host.append(regionName);

  function drawToolbar() {
    for (const [name, button] of Object.entries(toolButtons)) {
      button.setAttribute("aria-pressed", String(state.tool === name));
      button.disabled = state.readOnly && name !== "hand";
    }
    for (const [name, button] of Object.entries(colourButtons)) {
      button.setAttribute("aria-pressed", String(state.colour === name));
    }
    const stop = nearestWidthStop(state.width);
    widthSlider.value = String(stop);
    widthSlider.setAttribute("aria-valuetext", t.widths[stop]);
    widthPreview.dataset.size = String(stop);
    shapeButton.setAttribute("aria-pressed", String(SHAPES.includes(state.tool)));
    for (const [name, button] of Object.entries(paperButtons)) button.setAttribute("aria-pressed", String(state.canvas.paper === name));
    for (const [name, button] of Object.entries(pageButtons)) button.setAttribute("aria-pressed", String(state.canvas.page === name));
    for (const button of [shapeButton, colourButton, widthButton, paperButton, pageButton]) {
      button.show();
      button.disabled = state.readOnly;
    }
    refreshPageSwatches();
    widthSlider.disabled = state.readOnly;
    for (const button of [...Object.values(paperButtons), ...Object.values(pageButtons)]) button.disabled = state.readOnly;
    fingerButton.setAttribute("aria-pressed", String(state.fingerDraws));
    fingerButton.disabled = state.readOnly;
    undoButton.disabled = state.readOnly || !state.history.canUndo;
    redoButton.disabled = state.readOnly || !state.history.canRedo;
    deleteButton.disabled = state.readOnly || (state.selection.length === 0 && !state.frameSel);
    // The name field follows the selected region; while it is being typed in, it is left alone.
    if (document.activeElement !== regionName) {
      regionNamed = state.frameSel;
      // The field floats under the toolbar, so it never moves the sheet or adds a toolbar row.
      regionName.style.visibility = state.frameSel ? "visible" : "hidden";
      regionName.style.top = `${toolbar.offsetHeight + 4}px`;
      regionName.value = state.frameSel ? state.frameSel.label : "";
    }
    regionName.disabled = state.readOnly;
    if (state.readOnly) closeMenu();
  }

  function setTool(name, keepMenu = false) {
    if (!keepMenu) closeMenu();
    commitNote();
    state.tool = name;
    if (SHAPES.includes(name)) state.shape = name;
    if (name !== "select") {
      state.selection = [];
      state.frameSel = null;
    }
    drawToolbar();
    scheduleDraw();
  }
  // With something selected by the loop, a colour picked from the menu recolours the selection
  // (one undo step) instead of becoming the colour of the next line.
  function recolourSelection(name) {
    const edits = state.selection.filter((item) => item.color !== name).map((item) => ({ item, before: { color: item.color }, after: { color: name } }));
    closeMenu();
    if (edits.length) {
      for (const edit of edits) Object.assign(edit.item, edit.after);
      state.history.record({ edit: edits });
      changed();
    }
    drawToolbar();
  }
  function setColour(name) {
    if (state.tool === "select" && state.selection.length && !state.readOnly) return recolourSelection(name);
    state.colour = name;
    if (COLOURLESS_TOOLS.includes(state.tool)) setTool("pen");
    else {
      closeMenu();
      drawToolbar();
    }
  }
  function setWidth(value, keepMenu = false) {
    state.width = value;
    if (COLOURLESS_TOOLS.includes(state.tool)) setTool("pen", keepMenu);
    else {
      if (!keepMenu) closeMenu();
      drawToolbar();
    }
  }

  // Shows every page colour as it will look in the theme that is on now, and the one in use on the button.
  function refreshPageSwatches() {
    readColours();
    for (const [name, button] of Object.entries(pageButtons)) {
      const swatch = button.querySelector(".canvas-page-swatch");
      if (swatch) swatch.style.background = pageFill(name, state.background);
    }
    const shown = pageButton.querySelector(".canvas-page-swatch");
    if (shown) shown.style.background = pageFill(state.canvas.page, state.background);
  }
  // Paper and page colour are saved with the drawing and are one step each in the undo list.
  function setSetting(key, value) {
    if (state.readOnly || state.gesture) return;
    commitNote();
    closeMenu();
    const before = state.canvas[key];
    if (before === value) return;
    state.canvas[key] = value;
    state.history.record({ setting: { key, before, after: value } });
    changed();
  }

  // ---- history ----
  function undo() {
    if (state.readOnly || state.gesture) return;
    commitNote();
    if (state.history.undo(state.canvas)) changed();
  }
  function redo() {
    if (state.readOnly || state.gesture) return;
    commitNote();
    if (state.history.redo(state.canvas)) changed();
  }
  function changed() {
    // An undo or an erase may have removed selected items; the selection only keeps what is left.
    const present = new Set(state.canvas.items);
    state.selection = state.selection.filter((item) => present.has(item));
    if (state.frameSel && !state.canvas.frames.includes(state.frameSel)) state.frameSel = null;
    drawToolbar();
    scheduleDraw();
    onChange();
  }

  function clearSelection() {
    if (!state.selection.length && !state.frameSel) return;
    state.selection = [];
    state.frameSel = null;
    drawToolbar();
    scheduleDraw();
  }

  function deleteSelection() {
    if (state.readOnly || state.gesture) return;
    if (state.frameSel) {
      // The region goes; what is drawn inside it stays on the sheet, and a block that showed it says so.
      const index = state.canvas.frames.indexOf(state.frameSel);
      const frame = state.frameSel;
      state.frameSel = null;
      if (index >= 0) {
        state.canvas.frames.splice(index, 1);
        state.history.record({ frameRemove: { index, frame } });
        changed();
      }
      return;
    }
    if (!state.selection.length) return;
    const chosen = new Set(state.selection);
    const remove = [];
    state.canvas.items.forEach((item, index) => {
      if (chosen.has(item)) remove.push({ index, item });
    });
    state.canvas.items = state.canvas.items.filter((item) => !chosen.has(item));
    state.selection = [];
    if (remove.length) {
      state.history.record({ remove });
      changed();
    }
  }

  // ---- coordinates ----
  const toWorld = (sx, sy) => ({ x: (sx - state.view.x) / state.view.scale, y: (sy - state.view.y) / state.view.scale });
  function localPoint(event) {
    const box = surface.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  function zoomAt(sx, sy, factor) {
    const before = toWorld(sx, sy);
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, state.view.scale * factor));
    state.view = { scale, x: sx - before.x * scale, y: sy - before.y * scale };
  }

  // Puts the whole drawing in view (never bigger than life size), or the sheet's corner when empty.
  function fitView() {
    const box = surface.getBoundingClientRect();
    const around = boundsOf(state.canvas.items);
    if (!around || !box.width || !box.height) {
      state.view = { x: 24, y: 24, scale: 1 };
      return;
    }
    const margin = 32;
    const scale = Math.min(1, Math.max(MIN_SCALE, Math.min((box.width - 2 * margin) / Math.max(1, around.maxX - around.minX), (box.height - 2 * margin) / Math.max(1, around.maxY - around.minY))));
    state.view = { scale, x: margin - around.minX * scale, y: margin - around.minY * scale };
  }

  // ---- drawing on the screen ----
  function readColours() {
    readEnv(state);
  }

  // Where a shape corner goes: on the grid when snapping is on, otherwise exactly where the pointer is.
  function shapePoint(world) {
    return snapShapes() ? [snapToGrid(world.x), snapToGrid(world.y)] : [world.x, world.y];
  }


  const painter = createPainter(context, state);
  const noteBox = (note) => ({ x: note.x, y: note.y, w: note.w, h: state.editing && state.editing.item === note ? state.editing.height : note.h });
  const paintStroke = (stroke) => painter.stroke(stroke);
  const paintShape = (shape) => painter.shape(shape);
  const paintNote = (note, box) => painter.note(note, box);
  function paintItems(list) {
    const g = state.gesture;
    const live = g && g.kind === "pen" && g.stroke.tool === "highlighter" ? g.stroke : null;
    painter.items(list, { live, noteBox, hideText: (note) => Boolean(state.editing && state.editing.item === note) });
  }
  const paintPaper = (screen) => painter.paper(state.canvas.paper, state.view, screen);

  function paintSelection() {
    const around = boundsOf(state.selection);
    if (!around) return;
    const scale = state.view.scale;
    context.save();
    context.strokeStyle = state.accent;
    context.lineWidth = 1.5 / scale;
    context.setLineDash([6 / scale, 4 / scale]);
    const pad = 4 / scale;
    context.strokeRect(around.minX - pad, around.minY - pad, around.maxX - around.minX + 2 * pad, around.maxY - around.minY + 2 * pad);
    const handle = resizeHandle();
    if (handle) {
      const size = 10 / scale;
      context.setLineDash([]);
      context.fillStyle = state.accent;
      context.fillRect(handle.x - size / 2, handle.y - size / 2, size, size);
    }
    context.restore();
  }

  function paintFrameSelection(scale) {
    const f = state.frameSel;
    if (!f) return;
    context.save();
    context.strokeStyle = state.accent;
    context.fillStyle = state.accent;
    context.lineWidth = 2.5 / scale;
    context.setLineDash([]);
    context.strokeRect(f.x, f.y, f.w, f.h);
    const size = 10 / scale;
    for (const [x, y] of [[f.x, f.y], [f.x + f.w, f.y], [f.x, f.y + f.h], [f.x + f.w, f.y + f.h]]) context.fillRect(x - size / 2, y - size / 2, size, size);
    context.restore();
  }

  function draw() {
    state.frame = 0;
    const ratio = window.devicePixelRatio || 1;
    const box = surface.getBoundingClientRect();
    const width = Math.max(1, Math.round(box.width * ratio));
    const height = Math.max(1, Math.round(box.height * ratio));
    if (surface.width !== width || surface.height !== height) {
      surface.width = width;
      surface.height = height;
    }
    readColours();
    state.pageFill = pageFill(state.canvas.page, state.background);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = state.pageFill;
    context.fillRect(0, 0, surface.width, surface.height);
    const { x, y, scale } = state.view;
    context.setTransform(ratio * scale, 0, 0, ratio * scale, ratio * x, ratio * y);
    paintPaper(box);
    paintItems(state.canvas.items);
    painter.frames(state.canvas.frames, scale);
    paintFrameSelection(scale);
    const g = state.gesture;
    if (g && g.kind === "pen" && g.stroke.tool !== "highlighter") paintStroke(g.stroke);
    if (g && g.kind === "shape") paintShape(g.shape);
    if (g && g.kind === "notebox") {
      const box = boxOf(g.a, g.b);
      context.save();
      context.strokeStyle = state.accent;
      context.lineWidth = 1.5 / scale;
      context.setLineDash([6 / scale, 4 / scale]);
      context.strokeRect(box.x, box.y, box.w, box.h);
      context.restore();
    }
    if (state.editing && !state.editing.item) paintNote(state.editing.pending, { ...state.editing.pending, h: state.editing.height });
    paintSelection();
    if (g && g.kind === "lasso") {
      context.save();
      context.strokeStyle = state.accent;
      context.lineWidth = 1.5 / scale;
      context.setLineDash([6 / scale, 4 / scale]);
      context.beginPath();
      g.loop.forEach(([lx, ly], i) => (i ? context.lineTo(lx, ly) : context.moveTo(lx, ly)));
      context.closePath();
      context.stroke();
      context.restore();
    }
    if (g && g.kind === "erase") {
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.strokeStyle = state.colours.ink;
      context.lineWidth = 1;
      context.beginPath();
      context.arc(g.screen.x, g.screen.y, ERASER_PIXELS, 0, Math.PI * 2);
      context.stroke();
    }
    placeEditor();
  }

  function scheduleDraw() {
    if (!state.frame) state.frame = requestAnimationFrame(draw);
  }

  // ---- sticky notes ----
  // A note is typed into a real text box laid over the sheet, because that gives the keyboard,
  // selection, and the phone's own text handling for free. A new note is only added to the
  // drawing when it has text, so a stray tap leaves nothing behind.
  function noteAt(world) {
    for (let i = state.canvas.items.length - 1; i >= 0; i--) {
      const item = state.canvas.items[i];
      if (item.tool === "note" && world.x >= item.x && world.x <= item.x + item.w && world.y >= item.y && world.y <= item.y + item.h) return item;
    }
    return null;
  }

  function openNote(existing, box) {
    commitNote();
    const pending = existing ? null : { tool: "note", color: state.colour, x: box.x, y: box.y, w: box.w, h: box.h, text: "" };
    const subject = existing || pending;
    const area = make("textarea", "canvas-note-input");
    area.value = subject.text;
    area.maxLength = LIMITS.noteText;
    area.setAttribute("aria-label", t.noteLabel);
    area.placeholder = t.notePlaceholder;
    state.editing = { item: existing, pending, area, height: subject.h };
    area.addEventListener("input", () => {
      state.editing.height = Math.max(subject.h, noteTextHeight(wrapNoteText(area.value, subject.w).length));
      scheduleDraw();
    });
    area.addEventListener("blur", commitNote);
    area.addEventListener("keydown", (event) => {
      if (event.key === "Escape" || (event.key === "Enter" && (event.ctrlKey || event.metaKey))) {
        event.preventDefault();
        commitNote();
        surface.focus({ preventScroll: true });
      }
      event.stopPropagation();
    });
    stage.append(area);
    placeEditor();
    area.focus();
  }

  function wrapNoteText(text, width) {
    context.font = `${NOTE.fontSize}px ${state.font || "sans-serif"}`;
    return wrapText(text, width - 2 * NOTE.padding, (piece) => context.measureText(piece).width);
  }

  function placeEditor() {
    const e = state.editing;
    if (!e) return;
    const subject = e.item || e.pending;
    const { x, y, scale } = state.view;
    const area = e.area;
    area.style.left = `${x + subject.x * scale}px`;
    area.style.top = `${y + subject.y * scale}px`;
    area.style.width = `${subject.w * scale}px`;
    area.style.height = `${e.height * scale}px`;
    area.style.fontSize = `${NOTE.fontSize * scale}px`;
    area.style.lineHeight = `${NOTE.lineHeight * scale}px`;
    area.style.padding = `${NOTE.padding * scale}px`;
  }

  // Ends the typing: a changed note becomes one undo step, a new note with text is added.
  function commitNote() {
    const e = state.editing;
    if (!e) return;
    state.editing = null;
    const text = e.area.value.slice(0, LIMITS.noteText);
    e.area.remove();
    const subject = e.item || e.pending;
    // The size stays what it was drawn or resized to; it only grows if the text needs more room.
    const height = Math.max(subject.h, noteTextHeight(wrapNoteText(text, subject.w).length));
    if (e.item) {
      if (text !== e.item.text) {
        const entry = { item: e.item, before: { text: e.item.text, h: e.item.h }, after: { text, h: height } };
        Object.assign(e.item, entry.after);
        state.history.record({ edit: entry });
        changed();
      } else scheduleDraw();
      return;
    }
    if (!text.trim()) return scheduleDraw();
    if (!canAddItem(state.canvas)) {
      onNotice(t.full);
      return scheduleDraw();
    }
    const note = { ...e.pending, text, h: height };
    state.canvas.items.push(note);
    state.history.record({ add: note });
    changed();
  }

  // ---- gestures ----
  function startGesture(event, tool) {
    const screen = localPoint(event);
    const world = toWorld(screen.x, screen.y);
    const id = event.pointerId;
    if (tool === "eraser") {
      clearSelection();
      state.gesture = { kind: "erase", id, before: state.canvas.items.slice(), screen };
      eraseAt(world);
    } else if (tool === "select") {
      startSelect(id, screen, world);
    } else if (tool === "note") {
      clearSelection();
      const existing = noteAt(world);
      if (existing) {
        // The pointer is released a moment later; the text box must not lose focus to that.
        setTimeout(() => openNote(existing, null), 0);
        return;
      }
      if (!canAddItem(state.canvas)) return onNotice(t.full);
      // A new note is drawn as a box, the way a shape is: the person chooses its size.
      const corner = shapePoint(world);
      state.gesture = { kind: "notebox", id, a: corner, b: corner };
    } else if (SHAPES.includes(tool)) {
      clearSelection();
      const shape = { tool: "shape", kind: tool, color: state.colour, width: state.width, a: shapePoint(world), b: shapePoint(world) };
      state.gesture = { kind: "shape", id, shape, start: screen };
    } else {
      clearSelection();
      const mark = { tool, color: state.colour, width: state.width, points: [] };
      state.gesture = { kind: "pen", id, last: screen, stroke: mark };
      addPoint(event);
    }
  }

  // A press on the selection moves it; a press anywhere else starts a new loop.
  // A single selected note has a handle in its bottom right corner to change its size.
  function resizeHandle() {
    const [only] = state.selection;
    return state.selection.length === 1 && only.tool === "note" ? { x: only.x + only.w, y: only.y + only.h, item: only } : null;
  }

  function resizeNote(g, [px, py]) {
    const clamp = (value) => Math.min(LIMITS.noteMax, Math.max(LIMITS.noteMin, value));
    const w = clamp(px - g.item.x);
    g.item.w = w;
    // Never shorter than the text needs at this width.
    g.item.h = Math.max(clamp(py - g.item.y), noteTextHeight(wrapNoteText(g.item.text, w).length));
  }

  function startSelect(id, screen, world) {
    const hit = frameHit(state.canvas.frames, state.frameSel, world, state.view.scale, HANDLE_PIXELS);
    if (hit) {
      state.selection = [];
      state.frameSel = hit.frame;
      const { x, y, w, h } = hit.frame;
      state.gesture = { kind: "frame", id, part: hit.part, frame: hit.frame, start: world, before: { x, y, w, h } };
      drawToolbar();
      return;
    }
    const handle = resizeHandle();
    if (handle && Math.hypot(world.x - handle.x, world.y - handle.y) * state.view.scale <= HANDLE_PIXELS) {
      state.gesture = { kind: "resize", id, item: handle.item, before: { w: handle.item.w, h: handle.item.h } };
      return;
    }
    const around = boundsOf(state.selection);
    const slack = GRAB_PIXELS / state.view.scale;
    if (around && world.x >= around.minX - slack && world.x <= around.maxX + slack && world.y >= around.minY - slack && world.y <= around.maxY + slack) {
      const items = state.selection.slice();
      state.gesture = { kind: "move", id, items, start: world, anchor: moveAnchor(items), dx: 0, dy: 0 };
    } else {
      if (state.frameSel) {
        state.frameSel = null;
        drawToolbar();
      }
      state.gesture = { kind: "lasso", id, loop: [[world.x, world.y]], last: screen, length: 0 };
    }
  }

  function addPoint(event) {
    const g = state.gesture;
    const screen = localPoint(event);
    const points = g.stroke.points;
    if (points.length) {
      const dx = screen.x - g.last.x;
      const dy = screen.y - g.last.y;
      if (Math.hypot(dx, dy) < MIN_STEP_PIXELS) return;
    }
    if (points.length >= LIMITS.pointsPerStroke) return;
    const world = toWorld(screen.x, screen.y);
    // A mouse reports a fixed 0.5, so it draws the plain width. A highlighter ignores pressure.
    const pressure = g.stroke.tool === "highlighter" ? 0.5 : event.pressure > 0 ? Math.min(1, event.pressure) : 0.5;
    points.push([world.x, world.y, pressure]);
    g.last = screen;
  }

  function eraseAt(world) {
    const radius = ERASER_PIXELS / state.view.scale;
    const hit = itemsTouched(state.canvas, world.x, world.y, radius);
    for (const index of hit.reverse()) state.canvas.items.splice(index, 1);
  }

  // The pointer has moved from where the gesture began; `g.dx/dy` is how far the items have been
  // moved so far. With snapping on, the target is the nearest spot that puts the anchor on the grid.
  function moveGesture(g, world) {
    let total = [world.x - g.start.x, world.y - g.start.y];
    if (snapShapes() && g.anchor) total = snappedShift(g.anchor, total[0], total[1]);
    const dx = total[0] - g.dx;
    const dy = total[1] - g.dy;
    if (dx === 0 && dy === 0) return;
    // Items may not be pushed past the edge of the sheet the file can hold.
    if (!canMove(g.items, dx, dy)) return;
    for (const item of g.items) moveItem(item, dx, dy);
    g.dx = total[0];
    g.dy = total[1];
  }

  function finishGesture(cancelled) {
    const g = state.gesture;
    state.gesture = null;
    if (!g) return;
    if (g.kind === "pen") {
      const points = g.stroke.points;
      if (cancelled || !points.length) return scheduleDraw();
      // A stroke over a figure is cut to it; one that strays far becomes several strokes, which
      // go in (and come out again with undo) together.
      const parts = tidyStroke(g.stroke, state.canvas.items);
      const count = parts.reduce((sum, part) => sum + part.points.length, 0);
      if (!canAddItem(state.canvas, count) || state.canvas.items.length + parts.length > LIMITS.items) {
        onNotice(t.full);
        return scheduleDraw();
      }
      state.canvas.items.push(...parts);
      state.history.record({ add: parts.length === 1 ? parts[0] : parts });
      return changed();
    }
    if (g.kind === "notebox") {
      const box = boxOf(g.a, g.b);
      const smallest = Math.max(LIMITS.noteMin, NOTE_MIN_PIXELS / state.view.scale);
      if (cancelled) return scheduleDraw();
      if (box.w < smallest || box.h < smallest) {
        onNotice(t.noteDrag);
        return scheduleDraw();
      }
      box.w = Math.min(box.w, LIMITS.noteMax);
      box.h = Math.min(box.h, LIMITS.noteMax);
      // The pointer is released a moment later; the text box must not lose focus to that.
      setTimeout(() => openNote(null, box), 0);
      return scheduleDraw();
    }
    if (g.kind === "resize") {
      const after = { w: g.item.w, h: g.item.h };
      if (cancelled) Object.assign(g.item, g.before);
      else if (after.w !== g.before.w || after.h !== g.before.h) {
        state.history.record({ edit: { item: g.item, before: g.before, after } });
        return changed();
      }
      return scheduleDraw();
    }
    if (g.kind === "shape") {
      const size = Math.hypot(g.shape.b[0] - g.shape.a[0], g.shape.b[1] - g.shape.a[1]) * state.view.scale;
      if (cancelled || size < MIN_SHAPE_PIXELS) return scheduleDraw();
      if (!canAddItem(state.canvas)) {
        onNotice(t.full);
        return scheduleDraw();
      }
      state.canvas.items.push(g.shape);
      state.history.record({ add: g.shape });
      return changed();
    }
    if (g.kind === "lasso") {
      if (cancelled || g.length < MIN_SHAPE_PIXELS) {
        // A tap on a note selects it, so its size can be changed.
        const tapped = cancelled ? null : noteAt({ x: g.loop[0][0], y: g.loop[0][1] });
        if (tapped) {
          state.selection = [tapped];
          drawToolbar();
        } else clearSelection();
        return scheduleDraw();
      }
      state.selection = itemsInLoop(state.canvas, g.loop).map((index) => state.canvas.items[index]);
      drawToolbar();
      return scheduleDraw();
    }
    if (g.kind === "frame") {
      const after = { x: g.frame.x, y: g.frame.y, w: g.frame.w, h: g.frame.h };
      if (cancelled) Object.assign(g.frame, g.before);
      else if (Object.keys(after).some((key) => after[key] !== g.before[key])) {
        state.history.record({ frames: [{ frame: g.frame, before: g.before, after }] });
        return changed();
      }
      return scheduleDraw();
    }
    if (g.kind === "move") {
      if (cancelled) for (const item of g.items) moveItem(item, -g.dx, -g.dy);
      else if (g.dx !== 0 || g.dy !== 0) {
        state.history.record({ move: { items: g.items, dx: g.dx, dy: g.dy } });
        return changed();
      }
      return scheduleDraw();
    }
    // Erasing: what is gone now compared with how it was when the gesture began.
    const now = new Set(state.canvas.items);
    const remove = [];
    g.before.forEach((item, index) => {
      if (!now.has(item)) remove.push({ index, item });
    });
    if (cancelled) {
      state.canvas.items = g.before;
      return scheduleDraw();
    }
    if (remove.length) {
      state.history.record({ remove });
      changed();
    } else scheduleDraw();
  }

  function wantsToDraw(event) {
    if (state.readOnly || state.tool === "hand") return false;
    if (event.pointerType === "touch") return state.fingerDraws;
    if (event.pointerType === "mouse") return event.button === 0 && !state.spaceDown;
    return true; // a pen
  }

  function toolFor(event) {
    if (event.pointerType === "pen") {
      // The eraser end (32) always erases. The barrel button (2) does what the setting says.
      if (event.buttons & 32) return "eraser";
      if (event.buttons & 2) {
        const choice = penButton();
        if (choice === "erase") return "eraser";
        if (choice === "select") return "select";
      }
    }
    return state.tool;
  }

  function onDown(event) {
    surface.focus({ preventScroll: true });
    // Capture keeps the stroke going when the pen leaves the sheet. It can refuse (the pointer
    // may already be gone), and drawing must not stop because of that.
    try {
      surface.setPointerCapture(event.pointerId);
    } catch {
      // Nothing to do: the events still arrive while the pen is over the sheet.
    }
    if (event.pointerType === "touch" && !state.fingerDraws) {
      state.touches.set(event.pointerId, localPoint(event));
      beginTouchMove();
      return;
    }
    if (state.gesture) return;
    if (!wantsToDraw(event)) {
      if (event.pointerType === "mouse" || event.pointerType === "pen" || event.pointerType === "touch") {
        // Any pointer can move the sheet: the hand tool, the middle button or space with a mouse.
        state.gesture = { kind: "pan", id: event.pointerId, last: localPoint(event) };
      }
      return;
    }
    startGesture(event, toolFor(event));
    scheduleDraw();
  }

  function beginTouchMove() {
    if (state.touches.size === 2) {
      const [a, b] = [...state.touches.values()];
      // The point of the drawing under the middle of the two fingers is found once, when the
      // pinch starts. It must not be looked up again while moving: the view changes with every
      // move, and a point found in the changed view makes the drawing drift.
      const centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      state.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale: state.view.scale, world: toWorld(centre.x, centre.y) };
    } else state.pinch = null;
  }

  function onMove(event) {
    if (event.pointerType === "touch" && !state.fingerDraws && state.touches.has(event.pointerId)) {
      const before = state.touches.get(event.pointerId);
      const now = localPoint(event);
      state.touches.set(event.pointerId, now);
      if (state.touches.size === 1) {
        state.view.x += now.x - before.x;
        state.view.y += now.y - before.y;
      } else if (state.touches.size === 2 && state.pinch) {
        const [a, b] = [...state.touches.values()];
        const centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const { world } = state.pinch;
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, state.pinch.scale * (distance / state.pinch.distance)));
        // The same point of the drawing stays under the middle of the fingers; moving both
        // fingers together also moves the sheet.
        state.view = { scale, x: centre.x - world.x * scale, y: centre.y - world.y * scale };
      }
      scheduleDraw();
      return;
    }
    const g = state.gesture;
    if (!g || g.id !== event.pointerId) return;
    const now = localPoint(event);
    if (g.kind === "pan") {
      state.view.x += now.x - g.last.x;
      state.view.y += now.y - g.last.y;
      g.last = now;
    } else if (g.kind === "pen") {
      // A fast pen reports several points between two events; each one is kept.
      const events = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
      for (const part of events.length ? events : [event]) addPoint(part);
    } else if (g.kind === "shape") {
      g.shape.b = shapePoint(toWorld(now.x, now.y));
    } else if (g.kind === "notebox") {
      g.b = shapePoint(toWorld(now.x, now.y));
    } else if (g.kind === "resize") {
      resizeNote(g, shapePoint(toWorld(now.x, now.y)));
    } else if (g.kind === "lasso") {
      const world = toWorld(now.x, now.y);
      g.length += Math.hypot(now.x - g.last.x, now.y - g.last.y);
      g.last = now;
      if (g.loop.length < LIMITS.pointsPerStroke) g.loop.push([world.x, world.y]);
    } else if (g.kind === "frame") {
      const world = toWorld(now.x, now.y);
      Object.assign(g.frame, draggedFrame(g.before, g.part, world.x - g.start.x, world.y - g.start.y));
    } else if (g.kind === "move") {
      moveGesture(g, toWorld(now.x, now.y));
    } else {
      g.screen = now;
      eraseAt(toWorld(now.x, now.y));
    }
    scheduleDraw();
  }

  function onUp(event) {
    if (event.pointerType === "touch" && !state.fingerDraws && state.touches.has(event.pointerId)) {
      state.touches.delete(event.pointerId);
      beginTouchMove();
      return;
    }
    const g = state.gesture;
    if (!g || g.id !== event.pointerId) return;
    if (g.kind === "pan") state.gesture = null;
    else finishGesture(event.type === "pointercancel");
    scheduleDraw();
  }

  surface.addEventListener("pointerdown", onDown);
  surface.addEventListener("pointermove", onMove);
  surface.addEventListener("pointerup", onUp);
  surface.addEventListener("pointercancel", onUp);
  // Nothing in the sheet may show the system menu: a pen's long press would open it mid-stroke.
  surface.addEventListener("contextmenu", (event) => event.preventDefault());
  surface.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const point = localPoint(event);
      // A pinch on a trackpad arrives as a wheel with the control key down.
      if (event.ctrlKey) zoomAt(point.x, point.y, Math.exp(-event.deltaY * 0.01));
      else {
        state.view.x -= event.deltaX;
        state.view.y -= event.deltaY;
      }
      scheduleDraw();
    },
    { passive: false },
  );
  surface.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (mod && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      deleteSelection();
    } else if (event.key === "Escape") {
      clearSelection();
    } else if (event.key === " ") {
      event.preventDefault();
      state.spaceDown = true;
    }
  });
  surface.addEventListener("keyup", (event) => {
    if (event.key === " ") state.spaceDown = false;
  });
  new ResizeObserver(scheduleDraw).observe(surface);

  return {
    /** Shows a drawing. `problem` (a code) makes it read-only with a message. */
    show(canvas, problem) {
      commitNote();
      state.canvas = canvas || emptyCanvas();
      state.history = new DrawingHistory();
      state.readOnly = Boolean(problem);
      state.gesture = null;
      state.selection = [];
      state.touches.clear();
      notice.hidden = !problem;
      notice.textContent = problem ? t.problems[problem] || t.problems.broken : "";
      drawToolbar();
      fitView();
      scheduleDraw();
    },
    /** Makes the drawing read-only after the file was changed by something else. */
    lock(text) {
      commitNote();
      state.readOnly = true;
      notice.hidden = false;
      notice.textContent = text;
      drawToolbar();
    },
    /** Ends any note being typed, so its text is in the drawing before the drawing is saved. */
    finish: commitNote,
    get canvas() {
      return state.canvas;
    },
    get readOnly() {
      return state.readOnly;
    },
    focus() {
      surface.focus({ preventScroll: true });
    },
    redraw: scheduleDraw,
  };
}
