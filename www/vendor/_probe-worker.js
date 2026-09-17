self.onmessage = async () => {
  const post = (o) => self.postMessage(o);
  const out = [];
  self.Module = {};  // will be replaced by the glue's own `var Module = {}`
  try { importScripts("micropython.js"); }
  catch (e) { post({ type: "error", where: "importScripts", msg: String(e.message) }); return; }
  Module.onStdout = (c) => out.push(c);
  try {
    await new Promise((res) => { Module.onRuntimeInitialized = res; });
    post({ type: "ok", where: "init" });
    const init = Module.cwrap("mp_js_init", "null", ["number"]);
    const doStr = Module.cwrap("mp_js_do_str", "number", ["string"], { async: true });
    init(4 * 1024 * 1024);
    await doStr('print("hi from worker")\nprint(2 ** 10)');
    post({ type: "done", captured: out.join("") });
  } catch (e) { post({ type: "error", where: "runtime", msg: String(e.message) }); }
};
