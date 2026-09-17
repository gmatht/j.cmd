// ─── __module-worker-probe.js — run one engine in a MODULE worker ──
// Spawned by __module-worker-test.mjs. Deliberately imports src/ code
// exactly as www/otranspile-job.js does, so it exercises the worker
// realm (no document, no import map).
import { runJob } from "../src/otranspile-jobs.js";

self.onmessage = async (e) => {
  const { lang, source } = e.data || {};
  try {
    const res = await runJob(lang, String(source), {
      onStatus: (t) => self.postMessage({ type: "status", t }),
    });
    self.postMessage({ ok: true, ...res });
  } catch (err) {
    self.postMessage({ ok: false, out: "", err: String((err && err.message) || err), code: 1 });
  }
};
