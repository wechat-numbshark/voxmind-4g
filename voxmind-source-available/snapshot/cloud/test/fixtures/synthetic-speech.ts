/**
 * Deterministic 16 kHz 16-bit mono PCM for the transcription tests.
 *
 * An impulse train (140 Hz) passes through three resonators whose
 * center frequencies step through a fixed list every 1920 samples.
 * The result is generated here. It is not a microphone recording and
 * it does not contain words. Silero VAD still labels the buffer as
 * speech, which is what the trim and merge tests need. Tones and noise
 * do not.
 *
 * Length is 3.6 s (57600 samples). With the project's default VAD
 * settings the last speech frame falls at 3584 ms.
 */
const SR = 16_000;
const FORMANTS = [
  [730, 1090, 2440],
  [270, 2290, 3010],
  [300, 870, 2240],
  [530, 1840, 2480],
  [390, 1990, 2550],
];

export function syntheticSpeechPcm(): Buffer {
  const n = Math.floor(3.6 * SR);
  const y = new Float64Array(n);
  let y1 = [0, 0, 0];
  let y2 = [0, 0, 0];
  const f0 = 140;
  const hop = 1920;
  const bw = 80;
  for (let i = 0; i < n; i++) {
    const period = Math.round(SR / f0);
    let s = i % period === 0 ? 1 : 0;
    const f = FORMANTS[Math.floor(i / hop) % FORMANTS.length]!;
    const ny1 = [0, 0, 0];
    const ny2 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const theta = (2 * Math.PI * f[k]!) / SR;
      const r = Math.exp((-Math.PI * bw) / SR);
      const v = s + 2 * r * Math.cos(theta) * y1[k]! + (-r * r) * y2[k]!;
      ny2[k] = y1[k]!;
      ny1[k] = v;
      s = v;
    }
    y1 = ny1;
    y2 = ny2;
    y[i] = s;
  }
  let peak = 1e-9;
  for (const v of y) peak = Math.max(peak, Math.abs(v));
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round((y[i]! / peak) * 14000), i * 2);
  return out;
}
