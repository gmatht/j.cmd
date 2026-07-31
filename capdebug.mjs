import { GitFS } from "./src/fs/gitfs.js";
const g = new GitFS();
const repo = g._repo("https://github.com/gmatht/sh2perl");
const ad = await repo.advertise();
console.log("head:", ad.head);
// monkeypatch: capture what uploadPack would send by calling the internals
// replicate _fetchObject's call:
const { SmartHttpTransport } = await import("./src/fs/gitfs.js").catch(() => ({}));  // not exported
// Instead: build via module's uploadPackRequest by reading it — not exported either.
// Use fetch with the module's own transport by hitting it directly:
const t = new repo.constructor(); // no
