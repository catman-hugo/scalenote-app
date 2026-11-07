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
  DrawingHistory, LIMITS, NOTE, PEN_COLOURS, PEN_WIDTHS, SHAPES, nearestWidthStop, snapToGrid,
  arrowHead, boundsOf, boxOf, canAddItem, canMove, drawnWidth, ellipseOutline, emptyCanvas,
  itemsInLoop, itemsTouched, moveItem, noteHeight, widthAt, wrapText,
} from "./canvasrules.js";
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
// How far outside the selection box a press still counts as being on it.
const GRAB_PIXELS = 8;
const HIGHLIGHT_ALPHA = 0.35;
const NOTE_FILL_ALPHA = 0.22;
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
    editing: null,
    touches: new Map(),
    pinch: null,
    spaceDown: false,
    frame: 0,
    colours: {},
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
  toolbar.append(undoButton, redoButton, deleteButton, moreButton);
  host.prepend(toolbar, notice, stage);

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
    for (const button of [shapeButton, colourButton, widthButton]) {
      button.show();
      button.disabled = state.readOnly;
    }
    widthSlider.disabled = state.readOnly;
    fingerButton.setAttribute("aria-pressed", String(state.fingerDraws));
    fingerButton.disabled = state.readOnly;
    undoButton.disabled = state.readOnly || !state.history.canUndo;
    redoButton.disabled = state.readOnly || !state.history.canRedo;
    deleteButton.disabled = state.readOnly || state.selection.length === 0;
    if (state.readOnly) closeMenu();
  }

  function setTool(name, keepMenu = false) {
    if (!keepMenu) closeMenu();
    commitNote();
    state.tool = name;
    if (SHAPES.includes(name)) state.shape = name;
    if (name !== "select") state.selection = [];
    drawToolbar();
    scheduleDraw();
  }
  function setColour(name) {
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
    drawToolbar();
    scheduleDraw();
    onChange();
  }

  function clearSelection() {
    if (!state.selection.length) return;
    state.selection = [];
    drawToolbar();
    scheduleDraw();
  }

  function deleteSelection() {
    if (state.readOnly || state.gesture || !state.selection.length) return;
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
    const style = getComputedStyle(document.documentElement);
    for (const name of PEN_COLOURS) {
      // Ink follows the theme (black on light, white on dark); the others are fixed colours.
      state.colours[name] = style.getPropertyValue(name === "ink" ? "--text" : `--pen-${name}`).trim() || "#000";
    }
    state.background = style.getPropertyValue("--bg").trim() || "#fff";
    state.accent = style.getPropertyValue("--accent").trim() || "#06c";
    state.font = getComputedStyle(document.body).fontFamily || "sans-serif";
  }

  function paintStroke(stroke) {
    const colour = state.colours[stroke.color] || "#000";
    const points = stroke.points;
    context.strokeStyle = colour;
    context.fillStyle = colour;
    context.lineCap = "round";
    context.lineJoin = "round";
    if (stroke.tool === "highlighter") {
      // One path with one width: drawn in pieces, the see-through ends of each piece would
      // overlap and show as dark dots along the line.
      context.save();
      context.globalAlpha = HIGHLIGHT_ALPHA;
      context.lineWidth = drawnWidth(stroke);
      context.beginPath();
      context.moveTo(points[0][0], points[0][1]);
      if (points.length === 1) context.lineTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) context.lineTo(points[i][0], points[i][1]);
      context.stroke();
      context.restore();
      return;
    }
    if (points.length === 1) {
      context.beginPath();
      context.arc(points[0][0], points[0][1], widthAt(stroke.width, points[0][2]) / 2, 0, Math.PI * 2);
      context.fill();
      return;
    }
    // One short line per piece, because the width changes with the pressure along the way.
    for (let i = 1; i < points.length; i++) {
      context.lineWidth = widthAt(stroke.width, (points[i - 1][2] + points[i][2]) / 2);
      context.beginPath();
      context.moveTo(points[i - 1][0], points[i - 1][1]);
      context.lineTo(points[i][0], points[i][1]);
      context.stroke();
    }
  }

  // Where a shape corner goes: on the grid when snapping is on, otherwise exactly where the pointer is.
  function shapePoint(world) {
    return snapShapes() ? [snapToGrid(world.x), snapToGrid(world.y)] : [world.x, world.y];
  }

  function paintShape(shape) {
    context.strokeStyle = state.colours[shape.color] || "#000";
    context.lineWidth = shape.width;
    context.lineCap = "round";
    context.lineJoin = "round";
    const [ax, ay] = shape.a;
    const [bx, by] = shape.b;
    context.beginPath();
    if (shape.kind === "rect") {
      const box = boxOf(shape.a, shape.b);
      context.rect(box.x, box.y, box.w, box.h);
    } else if (shape.kind === "ellipse") {
      const outline = ellipseOutline(shape.a, shape.b, 64);
      outline.forEach(([x, y], i) => (i ? context.lineTo(x, y) : context.moveTo(x, y)));
      context.closePath();
    } else {
      context.moveTo(ax, ay);
      context.lineTo(bx, by);
      if (shape.kind === "arrow") {
        const head = arrowHead(shape.a, shape.b, Math.max(10, shape.width * 4));
        context.moveTo(head[0][0], head[0][1]);
        context.lineTo(bx, by);
        context.lineTo(head[1][0], head[1][1]);
      }
    }
    context.stroke();
  }

  // The lines of a note, cut to fit its width. Cached, because redrawing happens on every frame.
  function linesOf(note) {
    const cached = state.wrapped.get(note);
    if (cached && cached.text === note.text && cached.w === note.w) return cached.lines;
    context.font = `${NOTE.fontSize}px ${state.font}`;
    const lines = wrapText(note.text, note.w - 2 * NOTE.padding, (text) => context.measureText(text).width);
    state.wrapped.set(note, { text: note.text, w: note.w, lines });
    return lines;
  }

  function paintNote(note, box, withText) {
    const colour = state.colours[note.color] || "#000";
    context.fillStyle = state.background;
    context.fillRect(box.x, box.y, box.w, box.h);
    context.save();
    context.globalAlpha = NOTE_FILL_ALPHA;
    context.fillStyle = colour;
    context.fillRect(box.x, box.y, box.w, box.h);
    context.restore();
    context.strokeStyle = colour;
    context.lineWidth = 1.5;
    context.strokeRect(box.x, box.y, box.w, box.h);
    if (!withText) return;
    context.save();
    context.beginPath();
    context.rect(box.x, box.y, box.w, box.h);
    context.clip();
    context.fillStyle = state.colours.ink;
    context.font = `${NOTE.fontSize}px ${state.font}`;
    context.textBaseline = "top";
    linesOf(note).forEach((line, i) => context.fillText(line, box.x + NOTE.padding, box.y + NOTE.padding + i * NOTE.lineHeight));
    context.restore();
  }

  function paintItem(item) {
    if (item.tool === "shape") paintShape(item);
    else if (item.tool === "note") {
      const editing = state.editing && state.editing.item === item;
      paintNote(item, { x: item.x, y: item.y, w: item.w, h: editing ? state.editing.height : item.h }, !editing);
    } else paintStroke(item);
  }

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
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = state.background;
    context.fillRect(0, 0, surface.width, surface.height);
    const { x, y, scale } = state.view;
    context.setTransform(ratio * scale, 0, 0, ratio * scale, ratio * x, ratio * y);
    for (const item of state.canvas.items) paintItem(item);
    const g = state.gesture;
    if (g && g.kind === "pen") paintStroke(g.stroke);
    if (g && g.kind === "shape") paintShape(g.shape);
    if (state.editing && !state.editing.item) paintNote(state.editing.pending, { ...state.editing.pending, h: state.editing.height }, false);
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

  function openNote(existing, world) {
    commitNote();
    const pending = existing ? null : { tool: "note", color: state.colour, x: world.x, y: world.y, w: NOTE.width, h: NOTE.minHeight, text: "" };
    const subject = existing || pending;
    const area = make("textarea", "canvas-note-input");
    area.value = subject.text;
    area.maxLength = LIMITS.noteText;
    area.setAttribute("aria-label", t.noteLabel);
    area.placeholder = t.notePlaceholder;
    state.editing = { item: existing, pending, area, height: subject.h };
    area.addEventListener("input", () => {
      state.editing.height = noteHeight(wrapNoteText(area.value, subject.w).length);
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
    const height = noteHeight(wrapNoteText(text, (e.item || e.pending).w).length);
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
      if (!existing && !canAddItem(state.canvas)) return onNotice(t.full);
      // The pointer is released a moment later; the text box must not lose focus to that.
      setTimeout(() => openNote(existing, world), 0);
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
  function startSelect(id, screen, world) {
    const around = boundsOf(state.selection);
    const slack = GRAB_PIXELS / state.view.scale;
    if (around && world.x >= around.minX - slack && world.x <= around.maxX + slack && world.y >= around.minY - slack && world.y <= around.maxY + slack) {
      state.gesture = { kind: "move", id, items: state.selection.slice(), last: world, dx: 0, dy: 0 };
    } else {
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

  function moveGesture(g, world) {
    const dx = world.x - g.last.x;
    const dy = world.y - g.last.y;
    // Items may not be pushed past the edge of the sheet the file can hold.
    if (!canMove(g.items, dx, dy)) return;
    for (const item of g.items) moveItem(item, dx, dy);
    g.dx += dx;
    g.dy += dy;
    g.last = world;
  }

  function finishGesture(cancelled) {
    const g = state.gesture;
    state.gesture = null;
    if (!g) return;
    if (g.kind === "pen") {
      const points = g.stroke.points;
      if (cancelled || !points.length) return scheduleDraw();
      if (!canAddItem(state.canvas, points.length)) {
        onNotice(t.full);
        return scheduleDraw();
      }
      state.canvas.items.push(g.stroke);
      state.history.record({ add: g.stroke });
      return changed();
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
        clearSelection();
        return scheduleDraw();
      }
      state.selection = itemsInLoop(state.canvas, g.loop).map((index) => state.canvas.items[index]);
      drawToolbar();
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
      state.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale: state.view.scale, centre: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
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
        const world = toWorld(state.pinch.centre.x, state.pinch.centre.y);
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, state.pinch.scale * (distance / state.pinch.distance)));
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
    } else if (g.kind === "lasso") {
      const world = toWorld(now.x, now.y);
      g.length += Math.hypot(now.x - g.last.x, now.y - g.last.y);
      g.last = now;
      if (g.loop.length < LIMITS.pointsPerStroke) g.loop.push([world.x, world.y]);
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
