// The canvas of a page: a sheet you draw on with a pen, erase from, and move around.
//
// This file draws and listens; what a stroke is and how it is stored is in canvasrules.js, and
// saving is done by main.js (this view only says "something changed").
//
// Input rules, and why:
// - A pen or a mouse draws. A finger moves the sheet (one finger) or zooms it (two), so a hand
//   resting on the screen never leaves a mark. "Finger draws" in the toolbar turns that around
//   for a device that has no pen.
// - A pen's barrel button, or its eraser end, erases for as long as it is held.
// - Everything is stored in canvas units, so zooming only changes how it is drawn.
import { DrawingHistory, PEN_COLOURS, PEN_WIDTHS, canAddStroke, emptyCanvas, strokesTouched, widthAt } from "./canvasrules.js";
import { icon } from "./icons.js";
import { strings } from "./strings.js";

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
// The eraser is this many screen pixels wide, whatever the zoom.
const ERASER_PIXELS = 10;
// A new point closer than this many screen pixels to the last one adds nothing visible.
const MIN_STEP_PIXELS = 0.8;

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

/**
 * Builds the canvas inside `host`. `onChange()` is called after every finished gesture, and
 * `onNotice(text)` for a short message (for example, the drawing is full).
 */
export function createCanvasView(host, { onChange, onNotice }) {
  const t = strings.canvas;
  const state = {
    canvas: emptyCanvas(),
    history: new DrawingHistory(),
    readOnly: false,
    tool: "pen",
    colour: "ink",
    width: PEN_WIDTHS[1],
    fingerDraws: false,
    view: { x: 0, y: 0, scale: 1 },
    gesture: null,
    touches: new Map(),
    pinch: null,
    spaceDown: false,
    frame: 0,
    colours: {},
  };

  const toolbar = make("div", "canvas-toolbar");
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", t.toolbar);
  const notice = make("p", "canvas-problem");
  notice.setAttribute("role", "status");
  notice.hidden = true;
  const surface = make("canvas", "canvas-surface");
  surface.tabIndex = 0;
  surface.setAttribute("aria-label", t.surface);
  const context = surface.getContext("2d");

  // ---- toolbar ----
  const toolButtons = {};
  for (const [name, iconName] of [["pen", "pen"], ["eraser", "eraser"], ["hand", "hand"]]) {
    const button = toggleButton(t.tools[name], () => setTool(name));
    button.append(icon(iconName));
    toolButtons[name] = button;
    toolbar.append(button);
  }
  toolbar.append(make("span", "canvas-gap"));
  const colourButtons = {};
  for (const name of PEN_COLOURS) {
    const button = toggleButton(t.colours[name], () => setColour(name));
    button.classList.add("canvas-colour");
    button.dataset.colour = name;
    button.append(make("span", `canvas-swatch pen-${name}`));
    colourButtons[name] = button;
    toolbar.append(button);
  }
  toolbar.append(make("span", "canvas-gap"));
  const widthButtons = {};
  PEN_WIDTHS.forEach((value, index) => {
    const button = toggleButton(t.widths[index], () => setWidth(value));
    const line = make("span", "canvas-line");
    line.dataset.size = String(index);
    button.append(line);
    widthButtons[value] = button;
    toolbar.append(button);
  });
  toolbar.append(make("span", "canvas-gap"));
  const undoButton = make("button", "canvas-tool");
  undoButton.type = "button";
  undoButton.title = t.undo;
  undoButton.setAttribute("aria-label", t.undo);
  undoButton.append(icon("undo"));
  undoButton.addEventListener("click", undo);
  const redoButton = make("button", "canvas-tool");
  redoButton.type = "button";
  redoButton.title = t.redo;
  redoButton.setAttribute("aria-label", t.redo);
  redoButton.append(icon("redo"));
  redoButton.addEventListener("click", redo);
  const fingerButton = toggleButton(t.finger, () => {
    state.fingerDraws = !state.fingerDraws;
    drawToolbar();
  });
  fingerButton.classList.add("canvas-text-tool");
  fingerButton.textContent = t.finger;
  const resetButton = make("button", "canvas-text-tool", t.resetView);
  resetButton.type = "button";
  resetButton.addEventListener("click", () => {
    fitView();
    scheduleDraw();
  });
  toolbar.append(undoButton, redoButton, make("span", "canvas-gap"), fingerButton, resetButton);
  host.replaceChildren(toolbar, notice, surface);

  function drawToolbar() {
    for (const [name, button] of Object.entries(toolButtons)) {
      button.setAttribute("aria-pressed", String(state.tool === name));
      button.disabled = state.readOnly && name !== "hand";
    }
    for (const [name, button] of Object.entries(colourButtons)) {
      button.setAttribute("aria-pressed", String(state.colour === name));
      button.disabled = state.readOnly;
    }
    for (const [value, button] of Object.entries(widthButtons)) {
      button.setAttribute("aria-pressed", String(state.width === Number(value)));
      button.disabled = state.readOnly;
    }
    fingerButton.setAttribute("aria-pressed", String(state.fingerDraws));
    fingerButton.disabled = state.readOnly;
    undoButton.disabled = state.readOnly || !state.history.canUndo;
    redoButton.disabled = state.readOnly || !state.history.canRedo;
  }

  function setTool(name) {
    state.tool = name;
    drawToolbar();
  }
  function setColour(name) {
    state.colour = name;
    if (state.tool !== "pen") state.tool = "pen";
    drawToolbar();
  }
  function setWidth(value) {
    state.width = value;
    if (state.tool !== "pen") state.tool = "pen";
    drawToolbar();
  }

  // ---- history ----
  function undo() {
    if (state.readOnly || state.gesture) return;
    if (state.history.undo(state.canvas)) changed();
  }
  function redo() {
    if (state.readOnly || state.gesture) return;
    if (state.history.redo(state.canvas)) changed();
  }
  function changed() {
    drawToolbar();
    scheduleDraw();
    onChange();
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
    const strokes = state.canvas.strokes;
    const box = surface.getBoundingClientRect();
    if (!strokes.length || !box.width || !box.height) {
      state.view = { x: 24, y: 24, scale: 1 };
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const stroke of strokes) {
      for (const [x, y] of stroke.points) {
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    }
    const margin = 32;
    const scale = Math.min(1, Math.max(MIN_SCALE, Math.min((box.width - 2 * margin) / Math.max(1, maxX - minX), (box.height - 2 * margin) / Math.max(1, maxY - minY))));
    state.view = { scale, x: margin - minX * scale, y: margin - minY * scale };
  }

  // ---- drawing on the screen ----
  function readColours() {
    const style = getComputedStyle(document.documentElement);
    for (const name of PEN_COLOURS) {
      state.colours[name] = style.getPropertyValue(name === "ink" ? "--text" : `--sn-text-${name}`).trim() || "#000";
    }
    state.background = style.getPropertyValue("--bg").trim() || "#fff";
  }

  function paintStroke(stroke, points) {
    const colour = state.colours[stroke.color] || "#000";
    context.strokeStyle = colour;
    context.fillStyle = colour;
    context.lineCap = "round";
    context.lineJoin = "round";
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
    for (const stroke of state.canvas.strokes) paintStroke(stroke, stroke.points);
    const g = state.gesture;
    if (g && g.kind === "pen") paintStroke(g.stroke, g.stroke.points);
    if (g && g.kind === "erase") {
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.strokeStyle = state.colours.ink;
      context.lineWidth = 1;
      context.beginPath();
      context.arc(g.screen.x, g.screen.y, ERASER_PIXELS, 0, Math.PI * 2);
      context.stroke();
    }
  }

  function scheduleDraw() {
    if (!state.frame) state.frame = requestAnimationFrame(draw);
  }

  // ---- gestures ----
  function startGesture(event, kind) {
    const world = toWorld(localPoint(event).x, localPoint(event).y);
    if (kind === "erase") {
      state.gesture = { kind, id: event.pointerId, before: state.canvas.strokes.slice(), screen: localPoint(event) };
      eraseAt(world, event);
    } else {
      state.gesture = { kind, id: event.pointerId, last: localPoint(event), stroke: { tool: "pen", color: state.colour, width: state.width, points: [] } };
      addPoint(event);
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
    if (points.length >= 5000) return;
    const world = toWorld(screen.x, screen.y);
    // A mouse reports a fixed 0.5, so it draws the plain width.
    const pressure = event.pressure > 0 ? Math.min(1, event.pressure) : 0.5;
    points.push([world.x, world.y, pressure]);
    g.last = screen;
  }

  function eraseAt(world) {
    const radius = ERASER_PIXELS / state.view.scale;
    const hit = strokesTouched(state.canvas, world.x, world.y, radius);
    for (const index of hit.reverse()) state.canvas.strokes.splice(index, 1);
  }

  function finishGesture(cancelled) {
    const g = state.gesture;
    state.gesture = null;
    if (!g) return;
    if (g.kind === "pen") {
      const points = g.stroke.points;
      if (cancelled || !points.length) return scheduleDraw();
      if (!canAddStroke(state.canvas, points.length)) {
        onNotice(t.full);
        return scheduleDraw();
      }
      state.canvas.strokes.push(g.stroke);
      state.history.record({ add: g.stroke });
      return changed();
    }
    // Erasing: what is gone now compared with how it was when the gesture began.
    const now = new Set(state.canvas.strokes);
    const remove = [];
    g.before.forEach((stroke, index) => {
      if (!now.has(stroke)) remove.push({ index, stroke });
    });
    if (cancelled) {
      state.canvas.strokes = g.before;
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
    // The barrel button (2) or the eraser end (32) of a pen erases while held.
    if (event.pointerType === "pen" && (event.buttons & 2 || event.buttons & 32)) return "eraser";
    return state.tool === "eraser" ? "eraser" : "pen";
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
    startGesture(event, toolFor(event) === "eraser" ? "erase" : "pen");
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
    if (g.kind === "pan") {
      const now = localPoint(event);
      state.view.x += now.x - g.last.x;
      state.view.y += now.y - g.last.y;
      g.last = now;
    } else if (g.kind === "pen") {
      // A fast pen reports several points between two events; each one is kept.
      const events = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
      for (const part of events.length ? events : [event]) addPoint(part);
    } else {
      g.screen = localPoint(event);
      const world = toWorld(g.screen.x, g.screen.y);
      eraseAt(world);
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
      state.canvas = canvas || emptyCanvas();
      state.history = new DrawingHistory();
      state.readOnly = Boolean(problem);
      state.gesture = null;
      state.touches.clear();
      notice.hidden = !problem;
      notice.textContent = problem ? t.problems[problem] || t.problems.broken : "";
      drawToolbar();
      fitView();
      scheduleDraw();
    },
    /** Makes the drawing read-only after the file was changed by something else. */
    lock(text) {
      state.readOnly = true;
      notice.hidden = false;
      notice.textContent = text;
      drawToolbar();
    },
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
