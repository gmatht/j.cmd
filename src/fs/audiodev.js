// ─── AudioDevice: /dev/audio — Web Audio oscillator via files ──
//
// Plan 9-style audio: the Web Audio API is exposed as files under
// /dev/audio/. Set a frequency and waveform, then `echo on >
// /dev/audio/on` starts a continuous oscillator. Because the write
// comes from a typed shell command (a user gesture), browsers allow
// the AudioContext to start despite autoplay policies.
//
//   /dev/audio/info     read   Web Audio API availability + context state
//   /dev/audio/status   read   full state summary
//   /dev/audio/log      read   activity log
//   /dev/audio/on       write  start the oscillator
//   /dev/audio/off      write  stop the oscillator, release the graph
//   /dev/audio/freq     write  frequency in Hz (1..20000) · read current
//   /dev/audio/wave     write  sine | square | sawtooth | triangle
//   /dev/audio/gain     write  volume 0..1 · read current
//   /dev/audio/note     write  note name or Hz, optional duration in s
//                              ("A4 0.5" · "440" · "C#5 1.2")
//   /dev/audio/samples  write  a sample-accurate sound as text: the TSV
//                              the examples/sounds/sound-*.sh generators
//                              emit (#sound<TAB>name<TAB>rate<TAB>…
//                              samples<TAB>N<TAB> then rows of signed
//                              int16), or the simpler "RATE N s1 s2 …"
//                              — decoded and played as an AudioBuffer
//   /dev/audio/frame    read   WAV data URL of a 1s tone at current
//                              settings (readBlob: audio/wav Blob, so
//                              `cp /dev/audio/frame /pc/tone.wav`
//                              downloads a WAV file)
//
// Notes:
//   - The context is created lazily on the first sound-producing
//     write ("on" or "note"). Reads of freq/wave/gain/status work
//     without a context.
//   - In Node (the CLI) there is no AudioContext; sound writes fail
//     with a descriptive error instead of crashing the shell. The WAV
//     frame renderer is pure math and works anywhere.
// -----------------------------------------------------------------

const WAVES = ["sine", "square", "sawtooth", "triangle"];
const DEFAULT_FREQ = 440;
const DEFAULT_WAVE = "sine";
const DEFAULT_GAIN = 0.2;

// ─── Sample payload → { rate, samples } ────────────────────────
// The examples/sounds/sound-*.sh generators emit their sample list as
// a TSV whose header mirrors the texture TSVs:
//
//   #sound<TAB>name<TAB>22050<TAB>seed<TAB>…<TAB>samples<TAB>6615<TAB>
//   22478<TAB>-30155<TAB>…   ← signed 16-bit PCM, 32 per row
//
// (/dev/audio/samples accepts that exact text, or a bare
// "RATE N s1 s2 …" — the parse is the same either way: whitespace
// tokens, "samples" marks the count, everything after is the payload.)
function parseSamplesPayload(text) {
  const tokens = String(text).split(/\s+/).filter(Boolean);
  let rate = 22050;
  let n = 0;
  let start = 0;
  if (tokens[0] === "#sound") {
    // TSV header: #sound NAME RATE seed SEED samples N  — find the
    // "samples" marker (the header shape is fixed, but skipping to it
    // is robust against any future header additions)
    const si = tokens.indexOf("samples");
    if (si < 0 || !tokens[si + 1]) throw new Error("bad samples payload: no samples count");
    n = parseInt(tokens[si + 1], 10);
    start = si + 2;
    // the rate lives in the header at index 2
    rate = parseInt(tokens[2], 10);
  } else {
    // bare form: RATE N s1 s2 …
    if (tokens.length < 2) throw new Error("bad samples payload: need \"RATE N s1 s2 …\"");
    rate = parseInt(tokens[0], 10);
    n = parseInt(tokens[1], 10);
    start = 2;
  }
  if (!Number.isFinite(rate) || rate < 4000 || rate > 96000) {
    throw new Error(`bad sample rate ${rate} (4000..96000)`);
  }
  if (!Number.isFinite(n) || n < 1 || n > 5 * 60 * 96000) {
    throw new Error(`bad sample count ${n}`);
  }
  const have = tokens.length - start;
  if (have < n) throw new Error(`samples payload short: header says ${n}, found ${have}`);
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const v = parseInt(tokens[start + i], 10);
    if (!Number.isFinite(v)) throw new Error(`bad sample at ${i}: '${tokens[start + i]}'`);
    samples[i] = Math.max(-32768, Math.min(32767, v));
  }
  return { rate, samples };
}

// ─── Note-name → frequency ─────────────────────────────────────
// "A4" = 440 Hz, "C#5", "Bb3", plain "C" defaults to octave 4.
function noteToFreq(name) {
  const m = /^([A-Ga-g])([#b]?)(\d?)$/.exec(name.trim());
  if (!m) throw new Error(`bad note '${name}' (use e.g. A4, C#5, Bb3)`);
  const semis = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let s = semis[m[1].toUpperCase()];
  if (m[2] === "#") s += 1;
  if (m[2] === "b") s -= 1;
  const oct = m[3] ? parseInt(m[3], 10) : 4;
  const midi = (oct + 1) * 12 + s;
  if (midi < 0 || midi > 127) throw new Error(`note '${name}' out of MIDI range`);
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// ─── Pure WAV renderer (no AudioContext needed) ────────────────
// Renders `seconds` of the given waveform as a mono 16-bit PCM WAV
// data URL, so the oscillator state can be exported as a real file.
function renderWavDataUrl(freq, wave, seconds = 1.0, sampleRate = 22050) {
  if (!Number.isFinite(freq) || freq <= 0) freq = DEFAULT_FREQ;
  const n = Math.round(seconds * sampleRate);
  const data = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const phase = (t * freq) % 1;          // cycles completed this sample
    let s;
    switch (wave) {
      case "square":
        s = Math.sin(2 * Math.PI * freq * t) >= 0 ? 1 : -1;
        break;
      case "sawtooth":
        s = 2 * phase - 1;
        break;
      case "triangle":
        s = 4 * Math.abs(phase - 0.5) - 1;
        break;
      case "sine":
      default:
        s = Math.sin(2 * Math.PI * freq * t);
    }
    data[i] = Math.round(Math.max(-1, Math.min(1, s)) * 32767);
  }

  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;       // mono
  const byteRate = sampleRate * blockAlign;
  const dataSize = n * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const ascii = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);           // fmt chunk size
  view.setUint16(20, 1, true);            // PCM
  view.setUint16(22, 1, true);            // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);           // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < n; i++) view.setInt16(44 + i * 2, data[i], true);

  let bin = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return "data:audio/wav;base64," + btoa(bin);
}

class AudioDevice {
  constructor() {
    this._ctx = null;         // lazily created AudioContext
    this._osc = null;         // active OscillatorNode (null when idle)
    this._gainNode = null;    // master GainNode
    this._freq = DEFAULT_FREQ;
    this._wave = DEFAULT_WAVE;
    this._gain = DEFAULT_GAIN;
    this._startedAt = 0;      // epoch ms of the current run
    this._error = null;       // last start/play error, if any
    this._lastSamples = null; // { rate, n } of the last /samples play
    this._log = ["audio device ready.\n"];
  }

  _logLine(text) {
    this._log.push(text + "\n");
    if (this._log.length > 200) this._log.shift();
  }

  // ─── Environment checks ─────────────────────────────────────

  _ensureContext() {
    if (this._ctx) {
      // Resume in case the context was suspended by autoplay policy;
      // the write that triggered this call is a user gesture.
      if (this._ctx.state === "suspended" && this._ctx.resume) {
        this._ctx.resume().catch(() => {});
      }
      return this._ctx;
    }
    const Ctor = typeof AudioContext !== "undefined" ? AudioContext
      : typeof webkitAudioContext !== "undefined" ? webkitAudioContext
      : null;
    if (!Ctor) {
      throw new Error("audio not available (no Web Audio API in this environment — needs a browser)");
    }
    try {
      const ctx = new Ctor();
      this._ctx = ctx;
      this._logLine(`[context] created, sampleRate ${ctx.sampleRate}`);
      return ctx;
    } catch (e) {
      this._error = e && e.message ? e.message : String(e);
      this._logLine(`[context] create failed: ${this._error}`);
      throw new Error(`audio context create failed: ${this._error} (use https/localhost)`);
    }
  }

  // ─── Oscillator lifecycle ────────────────────────────────────

  get _running() {
    return !!this._osc;
  }

  _start() {
    if (this._osc) return;  // already running
    const ctx = this._ensureContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = this._wave;
    osc.frequency.value = this._freq;
    gain.gain.value = this._gain;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    this._osc = osc;
    this._gainNode = gain;
    this._startedAt = Date.now();
    this._error = null;
    this._logLine(`[osc] started ${this._freq} Hz ${this._wave} gain=${this._gain}`);
  }

  _stop() {
    const osc = this._osc;
    const ctx = this._ctx;
    const g = this._gainNode;
    if (!osc) return;  // already idle
    this._osc = null;
    this._gainNode = null;
    if (ctx && osc.stop) {
      // Ramp the gain down briefly so stopping doesn't click.
      const t = ctx.currentTime;
      if (g && g.gain) g.gain.setTargetAtTime(0, t, 0.01);
      try { osc.stop(t + 0.05); } catch {}
      osc.onended = () => { osc.disconnect(); };
      if (g && g.disconnect) {
        setTimeout(() => { try { g.disconnect(); } catch {} }, 120);
      }
    }
    this._startedAt = 0;
    this._logLine("[osc] stopped");
  }

  // ─── Live parameter changes ──────────────────────────────────

  _setFreq(freq) {
    if (!Number.isFinite(freq) || freq < 1 || freq > 20000) {
      throw new Error("freq needs a number in Hz between 1 and 20000");
    }
    this._freq = Math.round(freq * 10) / 10;
    if (this._osc && this._ctx) {
      this._osc.frequency.setTargetAtTime(this._freq, this._ctx.currentTime, 0.01);
    }
    this._logLine(`[freq] set to ${this._freq} Hz`);
  }

  _setWave(wave) {
    const w = String(wave).trim().toLowerCase();
    if (!WAVES.includes(w)) {
      throw new Error(`unknown wave '${w}' (use: ${WAVES.join(" | ")})`);
    }
    this._wave = w;
    if (this._osc) this._osc.type = w;  // oscillators retune live
    this._logLine(`[wave] set to ${w}`);
  }

  _setGain(gain) {
    const g = parseFloat(gain);
    if (!Number.isFinite(g) || g < 0 || g > 1) {
      throw new Error("gain needs a number between 0 and 1");
    }
    this._gain = g;
    if (this._gainNode && this._ctx) {
      this._gainNode.gain.setTargetAtTime(this._gain, this._ctx.currentTime, 0.01);
    }
    this._logLine(`[gain] set to ${g}`);
  }

  // ─── One-shot note ───────────────────────────────────────────

  _playNote(raw) {
    const ctx = this._ensureContext();
    const parts = String(raw).trim().split(/\s+/).filter(Boolean);
    let freq = this._freq;
    let dur = 1.0;
    if (parts.length) {
      const p0 = parts[0];
      if (/^[A-Ga-g][#b]?\d?$/.test(p0)) {
        freq = noteToFreq(p0);
      } else {
        const f = parseFloat(p0);
        if (!Number.isFinite(f) || f <= 0 || f > 20000) {
          throw new Error(`bad note '${p0}' (use a note name like A4, or Hz like 440)`);
        }
        freq = Math.round(f * 10) / 10;
      }
    }
    if (parts.length > 1) {
      const d = parseFloat(parts[1]);
      if (!Number.isFinite(d) || d <= 0 || d > 30) {
        throw new Error(`bad duration '${parts[1]}' (0 < seconds <= 30)`);
      }
      dur = d;
    }
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = this._wave;
    osc.frequency.value = freq;
    const t0 = ctx.currentTime;
    // Fast attack, hold, fast release — avoids clicks at both ends.
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(this._gain, t0 + 0.01);
    const releaseAt = t0 + Math.max(0.02, dur - 0.05);
    gain.gain.setValueAtTime(this._gain, releaseAt);
    gain.gain.linearRampToValueAtTime(0, t0 + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
    osc.onended = () => {
      try { osc.disconnect(); } catch {}
      try { gain.disconnect(); } catch {}
    };
    this._logLine(`[note] ${freq} Hz ${this._wave} for ${dur}s`);
  }

  // ─── One-shot sample-accurate sound ──────────────────────────
  // The payload is the exact TSV the examples/sounds generators emit
  // (int16 mono PCM at the declared rate) — decoded into an
  // AudioBuffer and played once. Short 5 ms fades stop the clicks the
  // raw buffer would click at its edges; the buffer is disconnected on
  // end so repeated plays don't leak nodes.
  _playSamples(text) {
    const { rate, samples } = parseSamplesPayload(text);
    const ctx = this._ensureContext();
    const buffer = ctx.createBuffer(1, samples.length, rate);
    buffer.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    src.buffer = buffer;
    src.connect(gain).connect(ctx.destination);
    const t0 = ctx.currentTime;
    const fade = Math.min(0.005, buffer.duration / 4);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(this._gain, t0 + fade);
    gain.gain.setValueAtTime(this._gain, t0 + Math.max(fade, buffer.duration - fade));
    gain.gain.linearRampToValueAtTime(0, t0 + buffer.duration);
    src.start(t0);
    src.onended = () => {
      try { src.disconnect(); } catch {}
      try { gain.disconnect(); } catch {}
    };
    this._lastSamples = { rate, n: samples.length };
    this._logLine(`[samples] ${samples.length} samples @ ${rate} Hz (${(samples.length / rate).toFixed(2)}s)`);
  }

  // ─── Read-only generated files ──────────────────────────────

  _status() {
    const lines = [];
    lines.push(`state: ${this._running ? "playing" : "idle"}`);
    lines.push(`freq: ${this._freq} Hz`);
    lines.push(`wave: ${this._wave}`);
    lines.push(`gain: ${this._gain}`);
    lines.push(`context: ${this._ctx ? this._ctx.state : "not created"}`);
    if (this._startedAt) {
      lines.push(`startedAt: ${new Date(this._startedAt).toISOString()}`);
    }
    if (this._error) lines.push(`lastError: ${this._error}`);
    return lines.join("\n") + "\n";
  }

  _info() {
    const lines = [];
    const hasCtor = typeof AudioContext !== "undefined" ||
                    typeof webkitAudioContext !== "undefined";
    lines.push(`Web Audio API: ${hasCtor ? "available" : "not available"}`);
    if (this._ctx) {
      lines.push(`sampleRate: ${this._ctx.sampleRate}`);
      lines.push(`state: ${this._ctx.state}`);
      if (this._ctx.baseLatency !== undefined) lines.push(`baseLatency: ${this._ctx.baseLatency}`);
      if (this._ctx.outputLatency !== undefined) lines.push(`outputLatency: ${this._ctx.outputLatency}`);
    } else {
      lines.push("sampleRate: — (context created on first sound write)");
    }
    return lines.join("\n") + "\n" + this._status();
  }

  // ─── VirtualFS interface (paths relative to /audio) ─────────

  async read(path) {
    const p = path.replace(/^\/+|\/+$/g, "") || "/";
    if (p === "/" || p === "info") return this._info();
    if (p === "status") return this._status();
    if (p === "log") return this._log.join("");
    if (p === "freq") return `${this._freq}\n`;
    if (p === "wave") return `${this._wave}\n`;
    if (p === "gain") return `${this._gain}\n`;
    if (p === "samples") return this._lastSamples
      ? `last samples: ${this._lastSamples.n} @ ${this._lastSamples.rate} Hz\n`
      : "no samples played yet\n";
    if (p === "frame") return renderWavDataUrl(this._freq, this._wave);
    throw new Error("ENOENT");
  }

  async write(path, content) {
    const p = path.replace(/^\/+|\/+$/g, "") || "/";
    const text = String(content).trim();
    if (p === "on") {
      this._start();
      return;
    }
    if (p === "off") {
      this._stop();
      return;
    }
    if (p === "freq") {
      this._setFreq(parseFloat(text));
      return;
    }
    if (p === "wave") {
      this._setWave(text);
      return;
    }
    if (p === "gain") {
      this._setGain(text);
      return;
    }
    if (p === "note") {
      this._playNote(text);
      return;
    }
    if (p === "samples") {
      this._playSamples(text);
      return;
    }
    throw new Error(`EROFS: cannot write /dev/audio/${p} ` +
      `(writable: on | off | freq <Hz> | wave ${WAVES.join("|")} | gain <0..1> | note <A4|Hz> [s] | samples <TSV>)`);
  }

  async list(path) {
    const p = path.replace(/^\/+|\/+$/g, "") || "/";
    if (p === "/") return ["frame", "freq", "gain", "info", "log", "note", "off", "on", "samples", "status", "wave"];
    throw new Error("ENOTDIR");
  }

  async stat(path) {
    const p = path.replace(/^\/+|\/+$/g, "") || "/";
    if (p === "/") return { type: "dir", size: 0, mtime: undefined };
    // Don't render a WAV just to stat the file; fixed size (like
    // /dev/clipboard and /dev/camera/frame).
    if (p === "frame") return { type: "file", size: 0, mtime: undefined };
    try {
      const text = await this.read(p);
      return { type: "file", size: text.length, mtime: undefined };
    } catch {
      return { type: "file", size: 0, mtime: undefined };
    }
  }

  async remove(path) {
    throw new Error("EROFS: Cannot remove audio devices");
  }
}

export { AudioDevice, noteToFreq, parseSamplesPayload, renderWavDataUrl };
