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
  if (typeof document === "undefined") return Promise.resolve();  // CLI: node:zlib
  ready ??= new Promise((resolve, reject) => {
    const url = new URL("../www/vendor/pako.min.js", import.meta.url);
    const s = document.createElement("script");
    s.src = url;
    s.onload = resolve;
    s.onerror = () => reject(new Error("failed to load vendor/pako.min.js"));
    document.head.appendChild(s);
  });
  return ready;
}
