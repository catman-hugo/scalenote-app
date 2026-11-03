// Every sentence the user sees lives here, not in the page code, so the app can be
// translated later without touching the screens. English only for now.
export const strings = {
  title: "ScaleNote spike: pen test",
  intro:
    "Draw on the white area with your pen, then with a finger, then with the mouse. " +
    "Press harder and softer, and press every button on the pen. " +
    "When you are done, press Copy report and paste the text to the person building the app.",
  clear: "Clear",
  copy: "Copy report",
  copied: "Report copied",
  copyFailed: "Could not copy. Select the report text and copy it by hand.",
  liveHeading: "Right now",
  reportHeading: "Report",
  labels: {
    pointerType: "Input type",
    pressure: "Pressure",
    tilt: "Tilt",
    buttons: "Buttons",
    position: "Position",
  },
  none: "none yet",
  report: {
    app: "App",
    webview: "Web view",
    screen: "Screen",
    typesSeen: "Input types seen",
    penPressure: "Pen pressure range",
    penPressureVaries: "Pen pressure changes while drawing",
    penTilt: "Pen tilt reported",
    penButtons: "Pen button values seen",
    touchSeen: "Finger touch seen",
    mouseSeen: "Mouse seen",
    yes: "yes",
    no: "no",
    nothingYet: "Nothing recorded yet. Draw on the white area first.",
  },
  buttonMeaning: {
    pen: { 1: "pen touching", 2: "barrel button", 32: "eraser button" },
    mouse: { 1: "left click", 2: "right click", 4: "wheel press" },
    touch: { 1: "finger touching" },
  },
};
