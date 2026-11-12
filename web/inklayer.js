// Drawing over the text of a page: a see-through sheet laid over the text view, and the small pen
// bar above it. What the ink is and how it is stored is in textink.js and canvasrules.js; saving
// is done by main.js (this file only says "something changed").
//
// How it works, and why:
// - The sheet is exactly as big as the visible part of the text box and is redrawn on every
//   scroll, so it never needs a size that grows with the page (a very long page would run into
//   the limits of a canvas).
// - Every stroke belongs to one block of the text and is stored as fractions of that block, so
//   it stays on its words when the window changes width (see textink.js).
// - Like the canvas view, a pen or a mouse draws and a finger scrolls the page, unless "Finger
//   draws" is on. The bar sits above the text instead of floating over it, so it never covers
//   the first lines, and it looks and works like the toolbar of the canvas.
import { DrawingHistory, LIMITS, PEN_COLOURS, PEN_WIDTHS, canAddItem, drawnWidth, nearestWidthStop, widthAt } from "./canvasrules.js";
import { blockTag, findBlock, inkFromScreen, inkToScreen, lineTouched, splitByBlock } from "./textink.js";
import { icon } from "./icons.js";
import { strings } from "./strings.js";

// How see-through a highlighter line is (the same as on the canvas).
const HIGHLIGHT_ALPHA = 0.35;
// The eraser is this many screen pixels wide, plus half the line it touches.
const ERASER_PIXELS = 10;
// A new point closer than this many screen pixels to the last one adds nothing visible.
const MIN_STEP_PIXELS = 0.8;
const TOOLS = ["pen", "highlighter", "eraser"];

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

// The blocks of the text are the children of the editor's root element, except the helper
// elements the editor adds for itself (cursor markers and so on).
const isBlock = (node) => node.nodeType === 1 && !/ProseMirror-/.test(node.className || "");
const kindOf = (node) => node.tagName.toLowerCase() + (node.dataset && node.dataset.type ? `.${node.dataset.type}` : "");

/**
 * `scroller` is the box the text scrolls in, `panes` holds it (the bar goes in front of it),
 * `body()` gives the editor's root element, `drawing()` gives `{ canvas, readOnly }` for the open
 * page or null when none is loaded.
 */
export function createInkLayer({ scroller, panes, body, drawing, onChange, onNotice }) {
  const t = strings.canvas;
  const s = strings.ink;
  const state = {
    active: false,
    visible: false,
    tool: "pen",
    colour: "ink",
    width: PEN_WIDTHS[1],
    fingerDraws: false,
    history: new DrawingHistory(),
    gesture: null,
    frame: 0,
    tagsDirty: true,
    tags: [],
    colours: {},
  };

  // A sticky box at the top of the scrolling text, with the sheet inside. Its own height is zero, so
  // it takes no room from the text. The sheet is placed by measuring, not by where this box is,
  // because before the first scroll this box sits below the top padding of the text box.
  const layer = make("div", "ink-layer");
  layer.hidden = true;
  const surface = make("canvas", "ink-surface");
  surface.tabIndex = -1;
  surface.setAttribute("aria-label", s.surface);
  layer.append(surface);
  scroller.prepend(layer);
  const context = surface.getContext("2d");

  // ---- the bar ----
  const bar = make("div", "ink-bar");
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", s.toolbar);
  bar.hidden = true;
  const menuHost = make("div", "ink-menus");
  const menus = {};
  let openMenu = null;
  function makeMenu(name, label, button, items) {
    const panel = make("div", "canvas-menu");
    panel.setAttribute("role", "group");
    panel.setAttribute("aria-label", label);
    panel.hidden = true;
    // Not `data-menu`: the sheet's toolbar has menus of the same names, and the two must not be mixed up.
    panel.dataset.inkMenu = name;
    panel.append(...items);
    button.setAttribute("aria-haspopup", "true");
    button.setAttribute("aria-expanded", "false");
    menus[name] = { name, button, panel };
    menuHost.append(panel);
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
    const hostBox = panes.getBoundingClientRect();
    const buttonBox = menu.button.getBoundingClientRect();
    const left = Math.max(4, Math.min(buttonBox.left - hostBox.left, hostBox.width - menu.panel.offsetWidth - 4));
    menu.panel.style.left = `${left}px`;
    menu.panel.style.top = `${buttonBox.bottom - hostBox.top + 4}px`;
    openMenu = menu;
  }
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (openMenu && !openMenu.panel.contains(event.target) && !openMenu.button.contains(event.target)) closeMenu();
    },
    true,
  );
  bar.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && openMenu) {
      const button = openMenu.button;
      closeMenu();
      button.focus();
    }
  });
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

  const toolButtons = {};
  for (const name of TOOLS) {
    const button = toggleButton(t.tools[name], () => setTool(name));
    button.dataset.tool = name;
    button.append(icon(name));
    toolButtons[name] = button;
  }
  bar.append(...Object.values(toolButtons), make("span", "canvas-gap"));

  const colourButtons = {};
  const colourButton = menuButton(t.colour, () => make("span", `canvas-swatch pen-${state.colour}`));
  colourButton.addEventListener("click", () => toggleMenu("colour"));
  makeMenu("colour", t.colour, colourButton, PEN_COLOURS.map((name) => {
    const button = toggleButton(t.colours[name], () => setColour(name));
    button.classList.add("ink-colour");
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
  bar.append(colourButton, widthButton, make("span", "canvas-gap"));

  const undoButton = plainButton(t.undo, "undo", () => undoRedo("undo"));
  const redoButton = plainButton(t.redo, "redo", () => undoRedo("redo"));
  const fingerButton = toggleButton(t.finger, () => {
    state.fingerDraws = !state.fingerDraws;
    drawBar();
  });
  fingerButton.dataset.action = "finger";
  fingerButton.append(icon("hand"));
  bar.append(undoButton, redoButton, fingerButton);
  panes.prepend(bar, menuHost);

  function drawBar() {
    for (const [name, button] of Object.entries(toolButtons)) button.setAttribute("aria-pressed", String(state.tool === name));
    for (const [name, button] of Object.entries(colourButtons)) button.setAttribute("aria-pressed", String(state.colour === name));
    colourButton.show();
    widthButton.show();
    widthSlider.value = String(nearestWidthStop(state.width));
    widthPreview.dataset.size = String(nearestWidthStop(state.width));
    fingerButton.setAttribute("aria-pressed", String(state.fingerDraws));
    const locked = isLocked();
    for (const button of [...Object.values(toolButtons), ...Object.values(colourButtons), colourButton, widthButton, widthSlider, fingerButton]) button.disabled = locked;
    undoButton.disabled = locked || !state.history.canUndo;
    redoButton.disabled = locked || !state.history.canRedo;
    if (locked) closeMenu();
  }
  function setTool(name) {
    state.tool = name;
    closeMenu();
    drawBar();
  }
  // Picking a colour or width while the eraser is in hand goes back to the pen.
  function setColour(name) {
    state.colour = name;
    if (state.tool === "eraser") state.tool = "pen";
    closeMenu();
    drawBar();
  }
  function setWidth(value, keepMenu = false) {
    state.width = value;
    if (state.tool === "eraser") state.tool = "pen";
    if (!keepMenu) closeMenu();
    drawBar();
  }
  const isLocked = () => {
    const d = drawing();
    return !d || d.readOnly;
  };

  // ---- the blocks of the text ----
  function blocks() {
    const root = body();
    return root ? [...root.children].filter(isBlock) : [];
  }
  // Fingerprints are only worked out again after the text changed, not on every scroll.
  function tags() {
    if (state.tagsDirty) {
      state.tags = blocks().map((node) => blockTag(kindOf(node), node.textContent));
      state.tagsDirty = false;
    }
    return state.tags;
  }
  function sheetBox() {
    return surface.getBoundingClientRect();
  }
  // A block's box in sheet pixels (the sheet's top left corner is 0, 0).
  function blockRect(node, sheet) {
    const box = node.getBoundingClientRect();
    return { left: box.left - sheet.left, top: box.top - sheet.top, width: box.width, height: box.height, bottom: box.bottom - sheet.top };
  }

  // ---- painting ----
  function readColours() {
    const style = getComputedStyle(document.documentElement);
    for (const name of PEN_COLOURS) {
      state.colours[name] = style.getPropertyValue(name === "ink" ? "--text" : `--pen-${name}`).trim() || "#000";
    }
  }
  function paintLine(stroke, points) {
    const colour = state.colours[stroke.color] || "#000";
    context.strokeStyle = colour;
    context.fillStyle = colour;
    context.lineCap = "round";
    context.lineJoin = "round";
    if (stroke.tool === "highlighter") {
      // One path with one width: drawn in pieces, the see-through ends would overlap into dark dots.
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

  // The screen positions of every piece of ink that has a block to sit on (a piece whose text is gone
  // is kept in the file but not drawn). Rectangles are measured once per block per call.
  function inkOnScreen(sheet) {
    const d = drawing();
    if (!d || !d.canvas.ink.length) return [];
    const nodes = blocks();
    const known = tags();
    const rects = new Map();
    const out = [];
    for (const item of d.canvas.ink) {
      const at = findBlock(known, item.anchor);
      if (at < 0 || !nodes[at]) continue;
      if (!rects.has(at)) rects.set(at, blockRect(nodes[at], sheet));
      out.push({ item, points: inkToScreen(item, rects.get(at)) });
    }
    return out;
  }

  // The layer sits inside the scroll box's padding, so before the first scroll it starts below and
  // right of the box's corner. The sheet is moved back by exactly that much, so it covers the whole
  // visible box, padding included. Otherwise a pen starting in the margin would hit the box
  // underneath and scroll the page instead of drawing.
  function placeSurface() {
    const box = scroller.getBoundingClientRect();
    const at = layer.getBoundingClientRect();
    surface.style.left = `${box.left + scroller.clientLeft - at.left}px`;
    surface.style.top = `${box.top + scroller.clientTop - at.top}px`;
  }

  function draw() {
    state.frame = 0;
    if (!state.visible) return;
    placeSurface();
    const ratio = window.devicePixelRatio || 1;
    const width = scroller.clientWidth;
    const height = scroller.clientHeight;
    if (surface.width !== Math.round(width * ratio) || surface.height !== Math.round(height * ratio)) {
      surface.width = Math.round(width * ratio);
      surface.height = Math.round(height * ratio);
      surface.style.width = `${width}px`;
      surface.style.height = `${height}px`;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    readColours();
    const sheet = sheetBox();
    const g = state.gesture;
    const hidden = g && g.kind === "erase" ? g.hit : null;
    for (const { item, points } of inkOnScreen(sheet)) {
      if (hidden && hidden.has(item)) continue;
      paintLine(item, points);
    }
    if (g && g.kind === "pen" && g.stroke.points.length) paintLine(g.stroke, g.stroke.points);
  }
  function scheduleDraw() {
    if (!state.frame) state.frame = requestAnimationFrame(draw);
  }
  scroller.addEventListener("scroll", scheduleDraw, { passive: true });
  new ResizeObserver(scheduleDraw).observe(scroller);

  // ---- drawing with the pointer ----
  const sheetPoint = (event) => {
    const box = sheetBox();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const changed = () => {
    drawBar();
    scheduleDraw();
    onChange();
  };

  // Keeps the pointer's events coming to the sheet when it leaves it. A pointer that is already gone
  // (a quick tap) makes this throw, and then drawing simply goes on without it.
  function capture(event) {
    try {
      surface.setPointerCapture(event.pointerId);
    } catch {
      // Nothing to capture.
    }
  }

  function onDown(event) {
    if (!state.active || state.gesture) return;
    placeSurface();
    const touch = event.pointerType === "touch";
    if (touch && !state.fingerDraws) {
      // A finger moves the page, so a hand resting on the screen never leaves a mark.
      state.gesture = { kind: "scroll", id: event.pointerId, lastY: event.clientY };
      capture(event);
      return;
    }
    if (isLocked()) {
      const d = drawing();
      onNotice(d ? t.problems.broken : s.noText);
      return;
    }
    event.preventDefault();
    closeMenu();
    capture(event);
    // The eraser end of a pen erases for as long as it is held.
    const erasing = state.tool === "eraser" || (event.pointerType === "pen" && (event.buttons & 32) !== 0);
    if (erasing) {
      state.gesture = { kind: "erase", id: event.pointerId, hit: new Set() };
      eraseAt(sheetPoint(event));
    } else {
      const stroke = { tool: state.tool, color: state.colour, width: state.width, points: [] };
      state.gesture = { kind: "pen", id: event.pointerId, stroke, last: null };
      addPoint(event);
    }
    scheduleDraw();
  }

  function addPoint(event) {
    const g = state.gesture;
    const p = sheetPoint(event);
    const points = g.stroke.points;
    if (g.last && Math.hypot(p.x - g.last.x, p.y - g.last.y) < MIN_STEP_PIXELS) return;
    if (points.length >= LIMITS.pointsPerStroke) return;
    // A mouse reports a fixed 0.5, so it draws the plain width. A highlighter ignores pressure.
    const pressure = g.stroke.tool === "highlighter" ? 0.5 : event.pressure > 0 ? Math.min(1, event.pressure) : 0.5;
    points.push([p.x, p.y, pressure]);
    g.last = p;
  }

  function eraseAt(point) {
    const g = state.gesture;
    for (const { item, points } of inkOnScreen(sheetBox())) {
      if (g.hit.has(item)) continue;
      if (lineTouched(points, point.x, point.y, ERASER_PIXELS + drawnWidth(item) / 2)) g.hit.add(item);
    }
  }

  function onMove(event) {
    const g = state.gesture;
    if (!g || g.id !== event.pointerId) return;
    if (g.kind === "scroll") {
      scroller.scrollTop -= event.clientY - g.lastY;
      g.lastY = event.clientY;
      return;
    }
    // A pen reports many positions between two frames; the coalesced ones keep the line smooth.
    const events = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    if (g.kind === "pen") for (const e of events.length ? events : [event]) addPoint(e);
    else eraseAt(sheetPoint(event));
    scheduleDraw();
  }

  function finish(cancelled) {
    const g = state.gesture;
    state.gesture = null;
    if (!g || g.kind === "scroll") return;
    const d = drawing();
    if (!d || cancelled) return scheduleDraw();
    if (g.kind === "erase") {
      if (!g.hit.size) return scheduleDraw();
      const removed = [];
      d.canvas.ink.forEach((item, index) => {
        if (g.hit.has(item)) removed.push({ index, item });
      });
      d.canvas.ink = d.canvas.ink.filter((item) => !g.hit.has(item));
      historyOf(d).record({ remove: removed });
      return changed();
    }
    const points = g.stroke.points;
    if (!points.length) return scheduleDraw();
    const nodes = blocks();
    if (!nodes.length) {
      onNotice(s.noText);
      return scheduleDraw();
    }
    const sheet = sheetBox();
    const rects = nodes.map((node) => blockRect(node, sheet));
    const pieces = splitByBlock(points, rects);
    if (!canAddItem(d.canvas, points.length + pieces.length) || d.canvas.items.length + d.canvas.ink.length + pieces.length > LIMITS.items) {
      onNotice(t.full);
      return scheduleDraw();
    }
    const known = tags();
    const added = pieces.map((piece) => inkFromScreen({ ...g.stroke, points: piece.points }, rects[piece.block], { block: piece.block, tag: known[piece.block] }));
    d.canvas.ink.push(...added);
    historyOf(d).record({ add: added });
    changed();
  }
  surface.addEventListener("pointerdown", onDown);
  surface.addEventListener("pointermove", onMove);
  surface.addEventListener("pointerup", () => finish(false));
  surface.addEventListener("pointercancel", () => finish(true));
  // A page that is not a place to be drawn on (a long press, a context menu) must not start a gesture.
  surface.addEventListener("contextmenu", (event) => event.preventDefault());

  // The history works on a canvas-shaped object whose `items` are the ink, so the undo and redo
  // of the sheet are used as they are. The ink list is replaced when erasing, so the wrapper
  // looks at the current one each time.
  const wrapper = { items: [] };
  function historyOf(d) {
    wrapper.items = d.canvas.ink;
    return state.history;
  }
  function undoRedo(which) {
    const d = drawing();
    if (!d || d.readOnly || state.gesture) return;
    historyOf(d);
    if (state.history[which](wrapper)) {
      d.canvas.ink = wrapper.items;
      changed();
    }
  }
  surface.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === "z") {
      event.preventDefault();
      undoRedo(event.shiftKey ? "redo" : "undo");
    } else if (key === "y") {
      event.preventDefault();
      undoRedo("redo");
    }
  });

  function applyVisibility() {
    layer.hidden = !state.visible;
    bar.hidden = !state.active;
    menuHost.hidden = !state.active;
    surface.classList.toggle("ink-drawing", state.active);
    if (!state.active) closeMenu();
    drawBar();
    scheduleDraw();
  }

  return {
    /** Shows the ink of the open page over the text (looking only, until `start`). */
    show() {
      state.visible = true;
      state.tagsDirty = true;
      applyVisibility();
    },
    /** Takes the ink away from the screen (the page was closed). */
    hide() {
      state.visible = false;
      state.active = false;
      state.gesture = null;
      state.history = new DrawingHistory();
      applyVisibility();
    },
    /** Starts drawing: the sheet takes the pen, the bar appears. */
    start() {
      state.visible = true;
      state.active = true;
      state.tagsDirty = true;
      state.history = new DrawingHistory();
      applyVisibility();
      // Placed and sized right now, not on the next frame, so the very first touch already
      // lands on a sheet that covers the whole text box.
      draw();
      surface.focus({ preventScroll: true });
    },
    /** Stops drawing; the ink stays on the text. */
    stop() {
      state.active = false;
      state.gesture = null;
      applyVisibility();
    },
    /** Says the text changed, so the blocks are measured and fingerprinted again. */
    refresh() {
      state.tagsDirty = true;
      if (state.visible) scheduleDraw();
    },
    /** Redraws, for example after a different drawing was loaded. */
    redraw() {
      state.history = new DrawingHistory();
      drawBar();
      scheduleDraw();
    },
    get active() {
      return state.active;
    },
    get visible() {
      return state.visible;
    },
  };
}
