// Spec 9.4: every log-derived string is cleaned before it reaches a terminal.

// ESC-introduced sequences: CSI (`ESC [ ... final`), OSC / DCS / SOS / PM / APC strings (ended by BEL or
// ESC \), and two-character escapes. Then C0, DEL, C1, bidi controls that reorder text, and U+2028/2029.
// oxlint-disable-next-line no-control-regex
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// oxlint-disable-next-line no-control-regex
const STRINGS = /\u001b[\]PX^_][\s\S]*?(?:\u0007|\u001b\\|$)/g;
// oxlint-disable-next-line no-control-regex
const ESC2 = /\u001b[\s\S]?/g;
// oxlint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u061c‎‏‪-‮⁦-⁩\u2028\u2029]/g;

export function sanitizeTerminal(s: string): string {
  return s.replace(CSI, '').replace(STRINGS, '').replace(ESC2, '').replace(CONTROLS, '');
}
