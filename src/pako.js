// ─── pako: lazy-load the vendored zlib (pako) in the browser ────
//
// pako.min.js (~23 KB) used to be a <script> tag in the HTML, fetched
// on every load. It's only needed when something actually inflates
// zlib data (zip browsing, git objects, the go/tcc toolchains), so it
// is now injected on demand. Consumers (zipfs, gitfs, go, tcc) call
// ensurePako() before touching window.pako; the CLI never loads it
// (node:zlib is used instead).
// -----------------------------------------------------------------

let ready = null;

export function ensurePako() {
  if (typeof globalThis.pako !== "undefined") return Promise.resolve();
  // True CLI (Node): no DOM, no worker global — the callers use node:zlib.
  if (typeof document === "undefined" && typeof WorkerGlobalScope === "undefined") {
    return Promise.resolve();
  }
  ready ??= (async () => {
    const url = new URL("../www/vendor/pako.min.js", import.meta.url).href;
    if (typeof document !== "undefined") {
      // Main thread: inject the UMD as a classic <script> (as before).
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = url;
        s.onload = resolve;
        s.onerror = () => reject(new Error("failed to load vendor/pako.min.js"));
        document.head.appendChild(s);
      });
    } else {
      // Worker (the otranspiler/tcc/go stages run in MODULE workers):
      // there is no `document`, so the old code returned early and left
      // globalThis.pako undefined — tcc/go then threw "no inflate
      // available". importScripts() is unavailable in module workers,
      // but dynamic import() of the UMD sets `self.pako` (the wrapper's
      // fallback branch) because module scope has no exports/define.
      await import(url);
    }
    if (typeof globalThis.pako === "undefined") {
      throw new Error("failed to load vendor/pako.min.js");
    }
  })();
  return ready;
}
