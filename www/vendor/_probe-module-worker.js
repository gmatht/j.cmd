self.onmessage = async () => {
  const post = (o) => self.postMessage(o);
  try {
    const mod = await import("./micropython.js");
    post({ type: "imported", selfModule: typeof self.Module, exports: Object.keys(mod).slice(0,5) });
  } catch (e) { post({ type: "error", msg: String(e.message).slice(0,200) }); }
  try {
    self.importScripts("./micropython.js");
    post({ type: "importScripts-ok", selfModule: typeof self.Module });
  } catch (e) { post({ type: "importScripts-threw", msg: String(e.message).slice(0,150) }); }
};
