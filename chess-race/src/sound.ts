// Tiny synthesized sound effects via the Web Audio API - no asset files, works
// offline. The AudioContext is created lazily on first use (after a user
// gesture, e.g. clicking Quick Play, so browsers allow playback).

let ctx: AudioContext | null = null;
let muted = false;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (AC) ctx = new AC();
  }
  if (ctx && ctx.state === "suspended") void ctx.resume();
  return ctx;
}

export function setMuted(m: boolean) {
  muted = m;
}
export function getMuted() {
  return muted;
}

function tone(
  freq: number,
  startOffset: number,
  duration: number,
  type: OscillatorType = "sine",
  gain = 0.2,
) {
  const a = audio();
  if (!a || muted) return;
  const t0 = a.currentTime + startOffset;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g);
  g.connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.03);
}

// A short countdown blip (3… 2… 1…).
export function playCountdownBeep() {
  tone(620, 0, 0.16, "triangle", 0.18);
}

// A brighter "GO!" when the race begins.
export function playGo() {
  tone(880, 0, 0.18, "sawtooth", 0.2);
  tone(1320, 0.1, 0.28, "sawtooth", 0.16);
}

// A rising arpeggio when a power-up is used.
export function playPowerup() {
  tone(523, 0, 0.09, "square", 0.14);
  tone(659, 0.08, 0.09, "square", 0.14);
  tone(988, 0.16, 0.16, "square", 0.16);
}

// A little fanfare on finishing.
export function playWin() {
  [523, 659, 784, 1046].forEach((f, i) =>
    tone(f, i * 0.13, 0.28, "triangle", 0.2),
  );
}
