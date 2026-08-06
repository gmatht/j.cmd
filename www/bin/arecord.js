// arecord v1 — record microphone audio (arecord-compatible options)
//
// NAME
//      arecord — record microphone audio
//
// SYNOPSIS
//      arecord [options] [file]
//
// DESCRIPTION
//      Records the browser microphone to the virtual filesystem as a
//      WAV file, with options mirroring the ALSA arecord command:
//      duration, format, rate, channels, file type and device. The
//      browser microphone is a mono source; -c 2 duplicates it into
//      both channels, and recordings are resampled to -r.
//
//      With no [file], records to $HOME/pcm.wav. Use a /pc/ path to
//      download the result (e.g. /pc/rec.wav). A file of "-" prints a
//      base64 data URL (this shell's stdout is text, so raw binary
//      cannot be written to it).
//
// OPTIONS
//      -d, --duration=SECONDS  record for SECONDS (default 10)
//      -f, --format=FORMAT     sample format: S16_LE (default), U8,
//                              S8, S24_LE, S32_LE, FLOAT_LE and their
//                              _BE twins; cd and dat are presets
//      -r, --rate=HZ           sample rate (default 8000, like arecord)
//      -c, --channels=N        channels: 1 (default) or 2 (stereo mix)
//      -t, --file-type=TYPE    wav (default), raw or au
//      -D, --device=NAME       microphone: default or a deviceId from
//                              arecord -l
//      -l, --list-devices      list capture hardware
//      -L, --list-pcms         list PCM names
//      -q, --quiet             suppress status lines
//      -v, --verbose           extra diagnostics
//      -h, --help              show this help
//
// EXAMPLES
//      arecord -d 5 out.wav
//      arecord -f cd -d 3 song.wav
//      arecord -r 16000 -c 1 -f S16_LE -d 2 clip.wav
//      arecord -d 2 -t raw clip.pcm
//      arecord -l
//
// NOTE: recording cannot be interrupted mid-flight — Ctrl+C returns
// to the prompt but the recording finishes its -d seconds in the
// background and still writes the file.

var isBrowser = typeof navigator !== "undefined" &&
  navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function";

var FORMATS = {
  U8:       { bits: 8,  tag: 1, signed: false, le: true,  label: "Unsigned 8 bit" },
  S8:       { bits: 8,  tag: 1, signed: true,  le: true,  label: "Signed 8 bit" },
  S16_LE:   { bits: 16, tag: 1, signed: true,  le: true,  label: "Signed 16 bit Little Endian" },
  S16_BE:   { bits: 16, tag: 1, signed: true,  le: false, label: "Signed 16 bit Big Endian" },
  S24_LE:   { bits: 24, tag: 1, signed: true,  le: true,  label: "Signed 24 bit Little Endian" },
  S24_BE:   { bits: 24, tag: 1, signed: true,  le: false, label: "Signed 24 bit Big Endian" },
  S32_LE:   { bits: 32, tag: 1, signed: true,  le: true,  label: "Signed 32 bit Little Endian" },
  S32_BE:   { bits: 32, tag: 1, signed: true,  le: false, label: "Signed 32 bit Big Endian" },
  FLOAT_LE: { bits: 32, tag: 3, signed: true,  le: true,  label: "Float 32 bit Little Endian" },
  FLOAT_BE: { bits: 32, tag: 3, signed: true,  le: false, label: "Float 32 bit Big Endian" },
};

function usage() {
  console.log("arecord — record microphone audio (arecord-compatible options)");
  console.log("usage: arecord [options] [file]");
  console.log("");
  console.log("  -d, --duration=SECONDS  record for SECONDS (default 10)");
  console.log("  -f, --format=FORMAT     S16_LE (default), U8, S8, S24_LE, S32_LE,");
  console.log("                          FLOAT_LE (and _BE twins), or cd / dat presets");
  console.log("  -r, --rate=HZ           sample rate (default 8000, like arecord)");
  console.log("  -c, --channels=N        1 (default) or 2 (stereo mix of the mono mic)");
  console.log("  -t, --file-type=TYPE    wav (default), raw, au");
  console.log("  -D, --device=NAME       microphone: default or a deviceId from -l");
  console.log("  -l, --list-devices      list capture devices");
  console.log("  -L, --list-pcms         list PCM names");
  console.log("  -q, --quiet             no status lines");
  console.log("  -v, --verbose           extra diagnostics");
  console.log("  -h, --help              this help");
  console.log("");
  console.log("file defaults to $HOME/pcm.wav; '-' prints a base64 data URL");
  console.log("(this shell's stdout is text — raw binary can't go through it)");
}

function sleep(ms) {
  return new Promise(function (res) { setTimeout(res, ms); });
}

function writeAscii(v, off, s) {
  for (var k = 0; k < s.length; k++) v.setUint8(off + k, s.charCodeAt(k));
}

function writeSample(v, off, s, fmt) {
  s = Math.max(-1, Math.min(1, s));
  if (fmt.tag === 3) { v.setFloat32(off, s, fmt.le); return; }
  if (fmt.bits === 8) {
    var b8 = fmt.signed ? Math.round(s * 127) : Math.round((s + 1) * 127.5);
    v.setUint8(off, b8 & 0xff);
  } else if (fmt.bits === 16) {
    v.setInt16(off, Math.round(s * 32767), fmt.le);
  } else if (fmt.bits === 24) {
    var b24 = Math.round(s * 8388607);
    if (fmt.le) {
      v.setUint8(off, b24 & 0xff);
      v.setUint8(off + 1, (b24 >> 8) & 0xff);
      v.setUint8(off + 2, (b24 >> 16) & 0xff);
    } else {
      v.setUint8(off, (b24 >> 16) & 0xff);
      v.setUint8(off + 1, (b24 >> 8) & 0xff);
      v.setUint8(off + 2, b24 & 0xff);
    }
  } else {
    v.setInt32(off, Math.round(s * 2147483647), fmt.le);
  }
}

function buildWav(samples, rate, ch, fmt) {
  var bytesPer = fmt.bits / 8;
  var block = ch * bytesPer;
  var dataSize = samples.length * bytesPer;
  var buf = new ArrayBuffer(44 + dataSize);
  var v = new DataView(buf);
  writeAscii(v, 0, "RIFF");
  v.setUint32(4, 36 + dataSize, true);
  writeAscii(v, 8, "WAVE");
  writeAscii(v, 12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, fmt.tag, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * block, true);
  v.setUint16(32, block, true);
  v.setUint16(34, fmt.bits, true);
  writeAscii(v, 36, "data");
  v.setUint32(40, dataSize, true);
  for (var j = 0; j < samples.length; j++) writeSample(v, 44 + j * bytesPer, samples[j], fmt);
  return new Uint8Array(buf);
}

function buildRaw(samples, fmt) {
  var bytesPer = fmt.bits / 8;
  var buf = new ArrayBuffer(samples.length * bytesPer);
  var v = new DataView(buf);
  for (var j = 0; j < samples.length; j++) writeSample(v, j * bytesPer, samples[j], fmt);
  return new Uint8Array(buf);
}

function buildAu(samples, rate, ch, fmt) {
  var enc;
  if (fmt.bits === 8) enc = 2;
  else if (fmt.bits === 16) enc = 3;
  else if (fmt.bits === 24) enc = 4;
  else if (fmt.tag === 3) enc = 6;
  else enc = 5;
  var bytesPer = fmt.bits / 8;
  var dataSize = samples.length * bytesPer;
  var buf = new ArrayBuffer(24 + dataSize);
  var v = new DataView(buf);
  writeAscii(v, 0, ".snd");
  v.setUint32(4, 24, false);
  v.setUint32(8, dataSize, false);
  v.setUint32(12, enc, false);
  v.setUint32(16, rate, false);
  v.setUint32(20, ch, false);
  var auFmt = { bits: fmt.bits, tag: fmt.tag, signed: true, le: false };
  for (var j = 0; j < samples.length; j++) writeSample(v, 24 + j * bytesPer, samples[j], auFmt);
  return new Uint8Array(buf);
}

function resample(mono, fromRate, toRate) {
  if (fromRate === toRate) return mono;
  var ratio = fromRate / toRate;
  var outLen = Math.round(mono.length / ratio);
  var out = new Array(outLen);
  for (var j = 0; j < outLen; j++) {
    var pos = j * ratio;
    var i0 = Math.min(Math.floor(pos), mono.length - 1);
    var i1 = i0 + 1 < mono.length ? i0 + 1 : i0;
    var frac = pos - i0;
    out[j] = mono[i0] + (mono[i1] - mono[i0]) * frac;
  }
  return out;
}

function expandChannels(mono, ch) {
  if (ch === 1) return mono;
  var out = new Array(mono.length * 2);
  for (var j = 0; j < mono.length; j++) {
    out[j * 2] = mono[j];
    out[j * 2 + 1] = mono[j];
  }
  return out;
}

function toBase64(bytes) {
  var bin = "";
  for (var j = 0; j < bytes.length; j += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(j, j + 0x8000));
  }
  return btoa(bin);
}

async function listDevices() {
  console.log("**** List of CAPTURE Hardware Devices ****");
  if (!isBrowser) {
    console.log("no capture hardware: not running in a browser with mediaDevices");
    return;
  }
  var devs = [];
  try { devs = await navigator.mediaDevices.enumerateDevices(); } catch (e) {}
  var mics = [];
  for (var i = 0; i < devs.length; i++) {
    if (devs[i].kind === "audioinput") mics.push(devs[i]);
  }
  if (!mics.length) {
    console.log("no microphone found (grant mic permission first, then try again)");
    return;
  }
  console.log("device 0: Default Microphone [default]");
  for (var j = 0; j < mics.length; j++) {
    var label = mics[j].label || ("Microphone " + (j + 1));
    console.log("device " + (j + 1) + ": " + label + " [" + mics[j].deviceId + "]");
  }
}

function listPcms() {
  console.log("**** List of PCMs ****");
  console.log("default");
  console.log("sysdefault");
  console.log("front");
  console.log("surround40");
  console.log("surround51");
  console.log("surround71");
  console.log("(this shell records through the browser microphone; -D accepts");
  console.log(" 'default' or a deviceId from: arecord -l)");
}

// ─── parse options (getopt-style: -d5, -r 16000, --duration=5, --) ───
var expanded = [];
for (var ai = 0; ai < args.length; ai++) {
  var arg = args[ai];
  if (arg === "--") {
    for (var ai2 = ai + 1; ai2 < args.length; ai2++) expanded.push(args[ai2]);
    break;
  }
  if (arg.length > 2 && arg.charAt(0) === "-" && arg.charAt(1) !== "-") {
    var rest = arg.slice(1);
    var i2 = 0;
    while (i2 < rest.length) {
      var c = rest.charAt(i2);
      if (c === "d" || c === "c" || c === "r" || c === "f" || c === "t" || c === "D") {
        expanded.push("-" + c);
        if (i2 + 1 < rest.length) expanded.push(rest.slice(i2 + 1));
        break;
      }
      if (c === "h" || c === "l" || c === "L" || c === "q" || c === "v" || c === "M") {
        expanded.push("-" + c);
        i2++;
        continue;
      }
      expanded.push("-" + c + rest.slice(i2 + 1));
      break;
    }
  } else {
    expanded.push(arg);
  }
}

var duration = null;
var channels = 1;
var rate = 8000;
var format = "S16_LE";
var fileType = "wav";
var device = "default";
var quiet = false;
var verbose = false;
var rateGiven = false;
var channelsGiven = false;
var positional = [];
var i = 0;
while (i < expanded.length) {
  var a = expanded[i];
  var opt = a;
  var inline = null;
  var eq = a.indexOf("=");
  if (a.length > 1 && a.charAt(0) === "-" && eq !== -1) {
    opt = a.slice(0, eq);
    inline = a.slice(eq + 1);
  }
  var val;
  if (opt === "-h" || opt === "--help") { usage(); return 0; }
  if (opt === "-l" || opt === "--list-devices") { await listDevices(); return 0; }
  if (opt === "-L" || opt === "--list-pcms") { listPcms(); return 0; }
  if (opt === "-q" || opt === "--quiet") { quiet = true; i++; continue; }
  if (opt === "-v" || opt === "--verbose") { verbose = true; i++; continue; }
  if (opt === "-M" || opt === "--mmap" || opt === "--disable-resample" ||
      opt === "--disable-channels" || opt === "--disable-format" ||
      opt === "--disable-softvol" || opt === "--test-position" ||
      opt === "--test-nowait") {
    if (verbose) console.log("arecord: ignoring option " + opt);
    i++;
    continue;
  }
  if (opt === "--test-coef" || opt === "--max-file-time") {
    if (verbose) console.log("arecord: ignoring option " + opt);
    if (inline === null) i++;   // skip its numeric argument
    i++;
    continue;
  }
  if (opt === "-d" || opt === "--duration") {
    val = inline !== null ? inline : expanded[++i];
    if (val === undefined) { console.log("arecord: option " + opt + " needs an argument"); usage(); return 2; }
    duration = parseFloat(val);
    if (!isFinite(duration) || duration <= 0 || duration > 3600) {
      console.log("arecord: invalid duration '" + val + "' (0 < seconds <= 3600)");
      return 1;
    }
    i++;
    continue;
  }
  if (opt === "-c" || opt === "--channels") {
    val = inline !== null ? inline : expanded[++i];
    if (val === undefined) { console.log("arecord: option " + opt + " needs an argument"); usage(); return 2; }
    channels = parseInt(val, 10);
    if (channels !== 1 && channels !== 2) {
      console.log("arecord: channels must be 1 or 2 (the browser mic is mono; 2 mixes it to stereo)");
      return 1;
    }
    channelsGiven = true;
    i++;
    continue;
  }
  if (opt === "-r" || opt === "--rate") {
    val = inline !== null ? inline : expanded[++i];
    if (val === undefined) { console.log("arecord: option " + opt + " needs an argument"); usage(); return 2; }
    rate = parseInt(val, 10);
    if (!isFinite(rate) || rate < 8000 || rate > 192000) {
      console.log("arecord: invalid rate '" + val + "' (8000..192000 Hz)");
      return 1;
    }
    rateGiven = true;
    i++;
    continue;
  }
  if (opt === "-f" || opt === "--format") {
    val = inline !== null ? inline : expanded[++i];
    if (val === undefined) { console.log("arecord: option " + opt + " needs an argument"); usage(); return 2; }
    var fv = String(val).toLowerCase();
    if (fv === "cd") {
      format = "S16_LE";
      if (!rateGiven) { rate = 44100; rateGiven = true; }
      if (!channelsGiven) { channels = 2; channelsGiven = true; }
    } else if (fv === "dat") {
      format = "S16_LE";
      if (!rateGiven) { rate = 48000; rateGiven = true; }
      if (!channelsGiven) { channels = 2; channelsGiven = true; }
    } else {
      var up = String(val).toUpperCase();
      if (!FORMATS[up]) {
        console.log("arecord: unknown format '" + val + "' (S16_LE, U8, S8, S24_LE, S32_LE, FLOAT_LE, cd, dat)");
        return 1;
      }
      format = up;
    }
    i++;
    continue;
  }
  if (opt === "-t" || opt === "--file-type") {
    val = inline !== null ? inline : expanded[++i];
    if (val === undefined) { console.log("arecord: option " + opt + " needs an argument"); usage(); return 2; }
    var tv = String(val).toLowerCase();
    if (tv === "voc") {
      console.log("arecord: voc output is not supported here (use wav, raw or au)");
      return 1;
    }
    if (tv !== "wav" && tv !== "raw" && tv !== "au") {
      console.log("arecord: unknown file type '" + val + "' (wav, raw, au)");
      return 1;
    }
    fileType = tv;
    i++;
    continue;
  }
  if (opt === "-D" || opt === "--device") {
    val = inline !== null ? inline : expanded[++i];
    if (val === undefined) { console.log("arecord: option " + opt + " needs an argument"); usage(); return 2; }
    device = val;
    i++;
    continue;
  }
  if (a === "-") { positional.push("-"); i++; continue; }
  if (a.charAt(0) === "-" && a.length > 1) {
    console.log("arecord: unrecognized option '" + a + "'");
    usage();
    return 2;
  }
  positional.push(a);
  i++;
}

if (positional.length > 1) {
  console.log("arecord: too many file arguments: " + positional.join(" "));
  usage();
  return 2;
}
var outArg = positional.length ? positional[0] : null;
var outPath;
if (outArg === "-") {
  outPath = "-";
} else if (outArg) {
  outPath = typeof fs._resolve === "function" ? fs._resolve(outArg) : outArg;
} else {
  outPath = (env.HOME || "/home") + "/pcm.wav";
}

if (duration === null) {
  duration = 10;
  if (!quiet) console.log("arecord: no -d duration given — recording 10 seconds (use -d N)");
}
if (duration > 120 && !quiet) {
  console.log("arecord: note: recordings are buffered in memory; " + duration + "s may be slow");
}

if (!isBrowser) {
  console.log("arecord: microphone capture needs a browser (getUserMedia)");
  console.log("(run this in the browser shell at http://localhost:8080/www/)");
  return 1;
}

var fmt = FORMATS[format];

var containerName = fileType === "wav" ? "WAVE" : fileType === "au" ? "Sun AU" : "raw data";
if (!quiet) {
  console.log("Recording " + containerName + " '" + outPath + "' : " + fmt.label +
    ", Rate " + rate + " Hz, " + (channels === 1 ? "Mono" : "Stereo"));
}

var Ctor = typeof AudioContext !== "undefined" ? AudioContext
  : typeof webkitAudioContext !== "undefined" ? webkitAudioContext : null;
if (!Ctor) {
  console.log("arecord: no Web Audio API in this environment (needs a browser)");
  return 1;
}

var stream = null;
try {
  var constraints = { audio: {} };
  if (device && device !== "default") constraints.audio.deviceId = { exact: device };
  stream = await navigator.mediaDevices.getUserMedia(constraints);
} catch (e) {
  console.log("arecord: cannot open microphone: " + (e && e.message ? e.message : String(e)));
  console.log("(grant microphone permission and use https or localhost)");
  return 1;
}

var ctx = new Ctor();
if (ctx.state === "suspended") {
  try { await ctx.resume(); } catch (e2) {}
}
if (ctx.state === "suspended") {
  for (var t = 0; t < stream.getTracks().length; t++) stream.getTracks()[t].stop();
  console.log("arecord: audio context suspended (autoplay policy) — click the page once, then retry");
  return 1;
}
var srcRate = ctx.sampleRate;
if (verbose) {
  console.log("arecord: context sampleRate " + srcRate + ", state " + ctx.state);
  var tr = stream.getAudioTracks();
  if (tr.length) {
    console.log("arecord: mic: " + (tr[0].label || "(unlabeled)") +
      (device !== "default" ? " (requested " + device + ")" : ""));
  }
}

var source = ctx.createMediaStreamSource(stream);
var node = ctx.createScriptProcessor(4096, 1, 1);
var zero = ctx.createGain();
zero.gain.value = 0;
source.connect(node);
node.connect(zero);
zero.connect(ctx.destination);

var samples = [];
node.onaudioprocess = function (e) {
  var ch = e.inputBuffer.getChannelData(0);
  for (var k = 0; k < ch.length; k++) samples.push(ch[k]);
};

await sleep(Math.round(duration * 1000) + 150);

node.onaudioprocess = null;
try { source.disconnect(); } catch (e5) {}
try { node.disconnect(); } catch (e6) {}
try { zero.disconnect(); } catch (e7) {}
for (var t2 = 0; t2 < stream.getTracks().length; t2++) stream.getTracks()[t2].stop();
try { await ctx.close(); } catch (e8) {}

var mono = resample(samples, srcRate, rate);
var interleaved = expandChannels(mono, channels);
var bytes;
if (fileType === "raw") bytes = buildRaw(interleaved, fmt);
else if (fileType === "au") bytes = buildAu(interleaved, rate, channels, fmt);
else bytes = buildWav(interleaved, rate, channels, fmt);

var mime = fileType === "wav" ? "audio/wav" : fileType === "au" ? "audio/basic" : "application/octet-stream";

if (outPath === "-") {
  console.log("data:" + mime + ";base64," + toBase64(bytes));
  if (!quiet) console.log("arecord: " + bytes.length + " bytes of " + fmt.label + " audio at " + rate + " Hz");
  return 0;
}

var blob = new Blob([bytes], { type: mime });
await fs.writeBlob(outPath, blob);
if (!quiet) {
  var secs = Math.round((samples.length / srcRate) * 10) / 10;
  console.log("arecord: wrote " + bytes.length + " bytes (" + secs + "s, " + fmt.label +
    ", " + rate + " Hz, " + (channels === 1 ? "mono" : "stereo") + ") to " + outPath);
  console.log("play it with: play " + outPath + "   (or cp " + outPath + " /pc/ to download)");
}
return 0;
