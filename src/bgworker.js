// ─── bgworker.js — background compute via a JS thread ──────────────
//
// Runs a transpiled shell script (bash → JS via the otranspilerl
// pipeline) on a SEPARATE THREAD so the main thread (the terminal / a
// game's menu loop) never blocks on it. The shell's `&` operator is
// dropped by the A1 emitter and the real-bash wasm only QUEUES `&`
// jobs sequentially — neither gives concurrency. This module is the
// thread primitive: a persistent Web Worker (browser) / worker_thread
// (Node) hosting the transpiler + sh2 runtime, driven by postMessage.
//
// Protocol (message-passing — no shared memory, so no
// SharedArrayBuffer / cross-origin-isolation requirement):
//   main → worker:  { id, scriptText, args }     run one script
//   worker → main:  { id, out, code, err }       its stdout/exit
//
// The worker creates its OWN fresh VirtualFS and sh2 runtime; it never
// touches the main thread's devices/files (the texture generators are
// self-contained pure computation — script text in, TSV out). The
// caller (e.g. a /dev/bg device) does the fs/device writes from the
// posted result, so nothing shared crosses the thread boundary.
//
// Node uses worker_threads (the worker source is an eval'd module that
// imports the pipeline by absolute file URL). The browser uses a Web
// Worker with a Blob URL whose script `import()`s the same modules by
// absolute URL (same-origin, module graph already served).

let worker = null;        // the persistent worker
let nextId = 1;
let ready = false;
const pending = [];       // messages queued until the worker is ready
const jobs = new Map();   // id → { resolve, reject, done, out, code, err }

function workerSource(moduleUrls) {
  // The worker body: transpile + run one script, capture stdout, post
  // back. `moduleUrls` are absolute (file: in Node, https: in the
  // browser) so both the eval'd Node worker and the Blob worker resolve
  // them without a base URL.
  return `
const mods = await Promise.all([
  import(${JSON.stringify(moduleUrls.bash2js)}),
  import(${JSON.stringify(moduleUrls.sh2runtime)}),
  import(${JSON.stringify(moduleUrls.fs)}),
]);
const { bashToJS } = mods[0];
const { createSh2Runtime } = mods[1];
const { fs } = mods[2];

// portable worker globals: Web Worker \`self\` vs Node worker_threads
// \`parentPort\`
const isNode = typeof process !== "undefined" && !!process.versions && !!process.versions.node;
const self = globalThis;
let post = (m) => self.postMessage(m);
if (isNode) {
  const { parentPort } = await import("node:worker_threads");
  post = (m) => parentPort.postMessage(m);
}

// the generated code writes through process.stdout.write — capture it
// (the A1 stripProcessEnv pass already removed process.env refs). The
// capture is PER JOB: runOne's are serialized through a queue so the
// single shared stdout capture can't cross between concurrent jobs
// (the menu submits all textures at once — without the queue, the last
// job's output won every read, e.g. stone.tsv got jpeg's output).
const __cap = { text: "" };
const stdoutWrite = (s) => { __cap.text += String(s); return true; };
if (isNode) {
  process.stdout.write = stdoutWrite;
} else {
  self.process = { stdout: { write: stdoutWrite }, env: {} };
}

// one job at a time — the shared stdout capture is only valid while a
// single job runs
const bgQueue = [];
let bgBusy = false;
async function pump() {
  if (bgBusy || !bgQueue.length) return;
  bgBusy = true;
  const { id, scriptText, args } = bgQueue.shift();
  await runOne(id, scriptText, args);
  bgBusy = false;
  pump();
}

async function runOne(id, scriptText, args) {
  try {
    __cap.text = "";
    const { js } = await bashToJS(fs, scriptText);
    const rt = createSh2Runtime({
      fs, env: {},
      shellExec: async () => ({ out: "", err: "", code: 0 }),
      stdout: { write: () => {} }, stderr: { write: () => {} },
      args, argv0: "bash",
    });
    const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2",
      "return (async () => { " + js + " })();");
    let code = 0;
    try {
      await Promise.race([
        fn(args, fs, {}, { write: () => {} }, { write: () => {} },
          async () => ({ out: "", err: "", code: 0 }), rt.sh2),
        new Promise((_, rej) => setTimeout(() => rej(new Error("bg-timeout")), 60000)),
      ]);
    } catch (e) { code = 1; }
    post({ id, out: __cap.text, code });
  } catch (e) {
    post({ id, err: String(e && e.message || e), code: 1 });
  }
}

const onMsg = (e) => {
  const d = e && (e.data !== undefined ? e.data : e);
  const { id, scriptText, args } = d || {};
  if (id === undefined) return;
  bgQueue.push({ id, scriptText: String(scriptText), args: Array.isArray(args) ? args : [] });
  pump();
};
if (isNode) {
  const { parentPort } = await import("node:worker_threads");
  parentPort.on("message", (d) => onMsg({ data: d }));
} else {
  self.onmessage = onMsg;
}
post({ ready: true });
`;
}

// resolve the pipeline modules by absolute URL from THIS module's url —
// the worker has no import.meta to base relative imports on
function moduleUrls() {
  const base = new URL(".", import.meta.url).href;
  return {
    bash2js: new URL("bash2js.js", base).href,
    sh2runtime: new URL("sh2runtime.js", base).href,
    fs: new URL("fs/index.js", base).href,
  };
}

async function spawnWorker() {
  const urls = moduleUrls();
  const src = workerSource(urls);
  const isNode = typeof process !== "undefined" && !!process.versions && !!process.versions.node;
  if (isNode) {
    const { Worker } = await import("node:worker_threads");
    worker = new Worker(src, { eval: true, type: "module" });
    worker.unref();   // don't keep the Node process alive for the worker
  } else {
    const blob = new Blob([src], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    worker = new Worker(url, { type: "module" });
  }
  const onMsg = (e) => {
    const m = e && (e.data !== undefined ? e.data : e);
    if (!m) return;
    if (m.ready) {
      ready = true;
      while (pending.length) worker.postMessage(pending.shift());
      return;
    }
    if (m.id === undefined) return;
    const job = jobs.get(m.id);
    if (!job) return;
    job.done = true;
    job.out = m.out || "";
    job.code = m.code;
    job.err = m.err;
    if (m.err) job.reject && job.reject(new Error(m.err));
    else job.resolve && job.resolve();
  };
  const onErr = (e) => {
    // a worker crash fails every outstanding job
    for (const [, job] of jobs) {
      if (!job.done && job.reject) job.reject(new Error("bg worker error: " + (e && e.message)));
    }
    worker = null;
  };
  if (isNode) {
    worker.on("message", onMsg);
    worker.on("error", onErr);
  } else {
    worker.onmessage = onMsg;
    worker.onerror = onErr;
  }
  return worker;
}

export async function ensureBgWorker() {
  if (!worker) await spawnWorker();
  return worker;
}

// submit a script for background execution; returns { id, promise }
export async function bgSubmit(scriptText, args) {
  await ensureBgWorker();
  const id = nextId++;
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  jobs.set(id, { id, done: false, out: "", code: null, err: null, resolve, reject, promise });
  const msg = { id, scriptText: String(scriptText), args: args || [] };
  if (ready) worker.postMessage(msg);
  else pending.push(msg);   // the worker is still importing — queue it
  return { id, promise };
}

// non-blocking status/result peek
export function bgPeek(id) {
  const j = jobs.get(id);
  if (!j) return { done: true, code: 127, out: "", err: "no such job" };
  return { done: j.done, code: j.code, out: j.out, err: j.err };
}

export function bgStatus() {
  return [...jobs.entries()].map(([id, j]) => `${id} ${j.done ? "done" : "running"}${j.code !== null ? " " + j.code : ""}`).join("\n") + "\n";
}
