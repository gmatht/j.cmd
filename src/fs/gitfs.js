// ─── GitFS: mount a git repo as a filesystem (read tree, read blobs) ──
//
// Real git, no API dependency. This backend speaks the git wire protocol
// directly over HTTP, so ANY git repository can be mounted as a directory
// tree — GitHub, GitLab, Gitea, cgit, or a bare repo served by a plain
// static file server.
//
// Path format:
//   /mount/git/                                         — featured repos + README
//   /mount/git/{host}/{repo-path}/{file-path}           — browse a repo
//   /mount/git/github.com/gmatht/sh2perl/               — list repo root
//   /mount/git/github.com/gmatht/sh2perl/README.md      — read a blob
//   /mount/git/gitlab.com/group/subgroup/repo/src/main.rs  — gitlab subgroups
//   /mount/git/localhost:8000/myrepo.git/               — dumb HTTP (static serve)
//
// How it works:
//   - Smart HTTP (git-upload-pack): the standard git protocol. Objects are
//     fetched lazily — one small request per commit/tree/blob — so `ls`
//     downloads only the trees it needs and `cat` only the blob it needs.
//     A directory listing never downloads file contents.
//   - Dumb HTTP (loose objects + packfiles): plain GETs. Works against any
//     static file server that is serving a (bare) git repo, which is handy
//     for local testing and LAN mounts.
//   - Objects are parsed at the wire level: commits, trees, blobs, and
//     packfiles including ofs-delta / ref-delta compression.
//
// In the browser, git hosts don't send CORS headers, so a CORS proxy is
// required there:  new GitFS({ proxy: "https://cors.example/" })  — the
// proxy is prefixed to every request URL. The Node CLI works directly.
// -----------------------------------------------------------------

const FEATURED = [
  { host: "github.com", path: "gmatht/sh2perl", desc: "the sh2perl transpiler" },
  { host: "github.com", path: "gmatht/debashc", desc: "shell script converter" },
  { host: "github.com", path: "torvalds/linux", desc: "Linux kernel source" },
  { host: "github.com", path: "rust-lang/rust", desc: "Rust compiler" },
  { host: "github.com", path: "python/cpython", desc: "Python interpreter" },
  { host: "github.com", path: "nodejs/node", desc: "Node.js runtime" },
  { host: "github.com", path: "git/git", desc: "Git version control" },
  { host: "gitlab.com", path: "gitlab-org/gitlab-foss", desc: "GitLab Community Edition" },
];

const TYPE_NAME = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const enc = new TextEncoder();
const dec = new TextDecoder();

function hex(buf) {
  let s = "";
  for (let i = 0; i < buf.length; i++) s += buf[i].toString(16).padStart(2, "0");
  return s;
}

function concatBytes(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
}

// SHA-1 over raw object bytes (header + "\0" + content). Browsers and
// modern Node both expose crypto.subtle; fall back to node:crypto.
async function sha1Hex(bytes) {
  if (globalThis.crypto && globalThis.crypto.subtle) {
    return hex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-1", bytes)));
  }
  const { createHash } = await import("node:crypto");
  return createHash("sha1").update(bytes).digest("hex");
}

// zlib inflate. git packs and loose objects are zlib streams.
//   node:    node:zlib (strict: throws on truncation, ignores trailing)
//   browser: global pako via script tag (lenient: may skip the adler32
//            trailer, so pack probing verifies the adler itself)
let _zlib = null;
let _usesPako = false;
function detectInflate() {
  if (_zlib !== null) return;
  if (typeof process !== "undefined" && process.versions && process.versions.node) {
    _zlib = { kind: "zlib" };  // resolved lazily below
  } else {
    _zlib = { kind: "pako" };
  }
  _usesPako = _zlib.kind === "pako";
}

async function inflate(buf) {
  detectInflate();
  if (_zlib.kind === "zlib") {
    if (!_zlib.mod) _zlib.mod = await import("node:zlib");
    return new Uint8Array(_zlib.mod.inflateSync(Buffer.from(buf)));
  }
  if (globalThis.pako) return new Uint8Array(globalThis.pako.inflate(buf));
  throw new Error("GitFS: pako is not loaded — add the pako script tag before the shell module");
}

// ─── pkt-line framing (git wire protocol) ─────────────────────

function pktLine(str) {
  const b = enc.encode(str);
  return concatBytes([enc.encode((b.length + 4).toString(16).padStart(4, "0")), b]);
}

function decodePktLines(buf) {
  const out = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(dec.decode(buf.subarray(i, i + 4)), 16);
    if (len === 0) { out.push({ flush: true }); i += 4; continue; }
    if (len === 1) { out.push({ delim: true }); i += 4; continue; }
    if (len === 2) { out.push({ end: true }); i += 4; continue; }
    out.push({ data: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return out;
}

// Build the body of a git-upload-pack request (protocol v0):
//   want <sha> <caps>
//   [filter <spec>]
//   (flush)
//   done
//   (flush)
function uploadPackRequest(wants, { filter, caps } = {}) {
  const lines = [];
  const capList = ["multi_ack_detailed", "side-band-64k", "ofs-delta"];
  if (filter) capList.push("filter");
  for (const cap of caps || []) {
    if (!capList.includes(cap) && cap !== "agent") capList.push(cap);
  }
  capList.push("agent=sh2runtime/0.1");
  lines.push(pktLine(`want ${wants[0]} ${capList.join(" ")}\n`));
  for (const w of wants.slice(1)) lines.push(pktLine(`want ${w}\n`));
  if (filter) lines.push(pktLine(`filter ${filter}\n`));
  lines.push(enc.encode("0000"));        // flush pkt-line
  lines.push(pktLine("done\n"));
  lines.push(enc.encode("0000"));        // flush pkt-line
  return concatBytes(lines);
}

// Parse a git-upload-pack response (side-band-64k) and return the raw
// packfile bytes. Channel 1 = pack data, 2 = progress, 3 = error.
function extractPack(buf) {
  const chunks = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(dec.decode(buf.subarray(i, i + 4)), 16);
    if (len === 0 || len === 1 || len === 2) { i += 4; continue; }
    const payload = buf.subarray(i + 4, i + len);
    i += len;
    const head = dec.decode(payload.subarray(0, Math.min(4, payload.length)));
    if (head === "NAK\n" || head.startsWith("ACK")) continue;  // negotiation result
    if (head === "ERR ") throw new Error("git-upload-pack: " + dec.decode(payload.subarray(4)));
    const ch = payload[0];
    if (ch === 1) chunks.push(payload.subarray(1));          // pack data
    else if (ch === 3) throw new Error("git-upload-pack: " + dec.decode(payload.subarray(1)));
    // ch === 2 → progress, ignore
  }
  const pack = concatBytes(chunks);
  if (dec.decode(pack.subarray(0, 4)) !== "PACK") {
    throw new Error("git-upload-pack: not a packfile response");
  }
  return pack;
}

// ─── Object parsing ───────────────────────────────────────────

async function parseLooseObject(buf) {
  const data = await inflate(buf);
  const nul = data.indexOf(0);
  const header = dec.decode(data.subarray(0, nul));
  const [type, sizeStr] = header.split(" ");
  const size = parseInt(sizeStr, 10);
  const body = data.subarray(nul + 1);
  if (body.length !== size) throw new Error("loose object size mismatch");
  return { type, data: body };
}

// Tree object: "<mode> <name>\0<20-byte sha>" entries
function parseTree(data) {
  const entries = [];
  let i = 0;
  while (i < data.length) {
    let j = i;
    while (data[j] !== 0x20) j++;
    const mode = parseInt(dec.decode(data.subarray(i, j)), 8);
    i = j + 1;
    j = i;
    while (data[j] !== 0x00) j++;
    const name = dec.decode(data.subarray(i, j));
    i = j + 1;
    entries.push({ mode, name, sha: hex(data.subarray(i, i + 20)) });
    i += 20;
  }
  return entries;
}

// Commit object: "tree <sha>\n[parent <sha>\n]* author ... committer ..."
function parseCommit(data) {
  const text = dec.decode(data);
  const tree = /^tree ([0-9a-f]{40})\n/.exec(text);
  const committer = /\ncommitter .*? <.*?> (\d+)/.exec(text);
  return {
    tree: tree && tree[1],
    committerDate: committer ? parseInt(committer[1], 10) * 1000 : undefined,
  };
}

// ─── Delta encoding (ofs-delta / ref-delta) ───────────────────
// git's little-endian 7-bit varint (delta base/result sizes)
function readLEB128(buf, st) {
  let result = 0, shift = 0, b;
  do {
    b = buf[st.i++];
    result |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return result;
}

function applyDelta(base, delta) {
  const st = { i: 0 };
  readLEB128(delta, st);              // base size
  const resultSize = readLEB128(delta, st);
  const out = new Uint8Array(resultSize);
  let o = 0;
  while (st.i < delta.length) {
    const op = delta[st.i++];
    if (op & 0x80) {
      // copy from base: offset/size encoded in the opcode's bit flags
      let ofs = 0, size = 0;
      if (op & 0x01) ofs |= delta[st.i++];
      if (op & 0x02) ofs |= delta[st.i++] << 8;
      if (op & 0x04) ofs |= delta[st.i++] << 16;
      if (op & 0x08) ofs |= delta[st.i++] << 24;
      if (op & 0x10) size |= delta[st.i++];
      if (op & 0x20) size |= delta[st.i++] << 8;
      if (op & 0x40) size |= delta[st.i++] << 16;
      // bit 7 is the copy marker itself — git sizes max out at 3 bytes
      if (size === 0) size = 0x10000;
      out.set(base.subarray(ofs, ofs + size), o);
      o += size;
    } else if (op > 0) {
      // literal insert
      out.set(delta.subarray(st.i, st.i + op), o);
      st.i += op;
      o += op;
    }
  }
  if (o !== resultSize) throw new Error("pack: delta size mismatch");
  return out;
}

// ─── Packfile parsing ─────────────────────────────────────────
// "PACK" <version> <count>, then one entry per object. Entries may be
// ofs-delta / ref-delta compressed. Returns [{ sha, type, data }].
// `lookup(sha)` resolves ref-delta bases that are not in this pack
// (thin packs / objects in loose storage).

// RFC 1950 adler32, used to locate a stream's exact end when the
// inflater (pako) does not verify the trailer itself.
function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a += bytes[i];
    b += a;
    if ((i & 0x3fff) === 0x3fff) { a %= 65521; b %= 65521; }
  }
  a %= 65521; b %= 65521;
  return ((b << 16) | a) >>> 0;
}

function readUInt32BE(buf, off) {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

async function parsePack(pack, lookup) {
  if (dec.decode(pack.subarray(0, 4)) !== "PACK") throw new Error("bad pack magic");
  const dv = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const version = dv.getUint32(4, false);
  if (version !== 2 && version !== 3) throw new Error("unsupported pack version " + version);
  const count = dv.getUint32(8, false);

  // Pass 1: entry headers + compressed extents (find each zlib stream's end)
  const entries = [];
  let off = 12;
  for (let n = 0; n < count; n++) {
    const entryOff = off;
    let c = pack[off++];
    const type = (c >> 4) & 7;
    let size = c & 0x0f;
    let shift = 4;
    while (c & 0x80) {
      c = pack[off++];
      size |= (c & 0x7f) << shift;
      shift += 7;
    }
    let baseOff = null, baseSha = null;
    if (type === 6) {                    // ofs-delta
      c = pack[off++];
      let ofs = c & 0x7f;
      while (c & 0x80) {
        c = pack[off++];
        ofs = ((ofs + 1) << 7) | (c & 0x7f);
      }
      baseOff = entryOff - ofs;
    } else if (type === 7) {             // ref-delta
      baseSha = hex(pack.subarray(off, off + 20));
      off += 20;
    }
    const compStart = off;
    const compEnd = await findCompressedEnd(pack, compStart, size);
    entries.push({ off: entryOff, type, size, compStart, compEnd, baseOff, baseSha });
    off = compEnd;
  }

  // Pass 2: inflate + resolve deltas. ofs-delta bases are always earlier
  // in the pack; ref-delta bases may appear later, so loop until stable.
  // Every resolved entry is immediately indexed by its computed sha, so
  // ref-delta bases that live in this pack resolve without any lookup.
  const byOff = new Map(entries.map(e => [e.off, e]));
  const bySha = new Map();               // sha → { type, data } (this pack)
  const state = entries.map(() => null); // per-entry resolution
  let changed = true;
  while (changed) {
    changed = false;
    for (let n = 0; n < entries.length; n++) {
      if (state[n]) continue;
      const e = entries[n];
      let base = null;
      if (e.type === 6) {
        const baseEntry = byOff.get(e.baseOff);
        base = baseEntry ? state[entries.indexOf(baseEntry)] : null;
        if (!base) throw new Error("pack: ofs-delta base unresolved");
      } else if (e.type === 7) {
        base = bySha.get(e.baseSha);     // may resolve in a later pass
      }
      if (e.type === 6 || e.type === 7) {
        if (!base) continue;             // ref-delta base not seen yet
        const delta = await inflate(pack.subarray(e.compStart, e.compEnd));
        state[n] = { type: base.type, data: applyDelta(base.data, delta) };
        bySha.set(await objectSha(state[n]), state[n]);
        changed = true;
      } else {
        const data = await inflate(pack.subarray(e.compStart, e.compEnd));
        state[n] = { type: TYPE_NAME[e.type], data };
        bySha.set(await objectSha(state[n]), state[n]);
        changed = true;
      }
    }
  }

  // Ref-delta bases that are not in this pack (thin packs, or objects in
  // loose storage / other packs) are resolved via `lookup`, once per sha.
  const missing = entries.filter((e, n) => !state[n]);
  if (missing.length && lookup) {
    const fetched = new Map();           // baseSha → { type, data } | null
    for (let n = 0; n < entries.length; n++) {
      if (state[n] || entries[n].type !== 7) continue;
      const e = entries[n];
      if (!fetched.has(e.baseSha)) {
        let base = null;
        try { base = await lookup(e.baseSha); } catch { base = null; }
        fetched.set(e.baseSha, base);
      }
      const base = fetched.get(e.baseSha);
      if (base) {
        const delta = await inflate(pack.subarray(e.compStart, e.compEnd));
        state[n] = { type: base.type, data: applyDelta(base.data, delta) };
        bySha.set(await objectSha(state[n]), state[n]);
      }
    }
  }

  // Pass 3: collect everything resolved.
  const out = [];
  for (let n = 0; n < entries.length; n++) {
    if (!state[n]) throw new Error("pack: unresolved ref-delta base " + entries[n].baseSha);
    const { type, data } = state[n];
    const header = `${type} ${data.length}\0`;
    const sha = await sha1Hex(concatBytes([enc.encode(header), data]));
    bySha.set(sha, { type, data });
    out.push({ sha, type, data });
  }
  return out;
}

// sha1 of an object: "<type> <size>\0<data>"
async function objectSha({ type, data }) {
  const header = `${type} ${data.length}\0`;
  return sha1Hex(concatBytes([enc.encode(header), data]));
}

// Find the end of the zlib stream starting at `start` (whose inflated
// size is `expectedSize`) without knowing the compressed length ahead of
// time. A complete stream inflates to exactly `expectedSize` bytes and
// ends with its adler32 trailer, so "inflates completely" is monotone in
// the end offset: probe up, then binary-search for the smallest end that
// yields a full object. zlib throws on truncated input; pako silently
// returns partial output and may skip the trailer, so the completion
// check is the length plus (for pako) the presence of the adler32.
async function findCompressedEnd(pack, start, expectedSize) {
  if (start >= pack.length) throw new Error("pack: truncated entry");
  detectInflate();
  let adler = null;
  const complete = async (end) => {
    let out;
    try {
      out = await inflate(pack.subarray(start, end));
    } catch { return false; }
    if (out.length !== expectedSize) return false;
    if (_usesPako) {
      if (adler === null) adler = adler32(out);
      // pako may have stopped before the trailer: require the adler32 of
      // the output to appear in the slice (it sits just past the data).
      for (let p = end - 4; p >= start; p--) {
        if (readUInt32BE(pack, p) === adler) return true;
      }
      return false;
    }
    return true;
  };
  let lo = start + 1;
  let hi = Math.min(pack.length, start + Math.max(64, Math.ceil(expectedSize / 2)));
  for (;;) {
    if (await complete(hi)) break;
    const span = hi - start;
    if (hi >= pack.length || span >= pack.length - start) {
      throw new Error("pack: truncated zlib stream");
    }
    hi = Math.min(pack.length, start + Math.ceil(span * 1.5));
  }
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (await complete(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// ─── Transports ───────────────────────────────────────────────
// Smart HTTP: the standard git wire protocol over HTTP.

class SmartHttpTransport {
  constructor(baseUrl, proxy) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.proxy = proxy || "";
  }

  _url(p) { return this.proxy + this.baseUrl + p; }

  async advertisement() {
    let resp;
    try {
      resp = await fetch(this._url("/info/refs?service=git-upload-pack"), {
        headers: { Accept: "application/x-git-upload-pack-advertisement, */*" },
      });
    } catch { return null; }
    if (!resp.ok) return null;
    let buf;
    try { buf = new Uint8Array(await resp.arrayBuffer()); } catch { return null; }

    const refs = new Map();
    let caps = new Set(), symref = null, head = null;
    try {
      for (const p of decodePktLines(buf)) {
        if (!p.data) continue;
        const text = dec.decode(p.data);
        const m = /^([0-9a-f]{40}) ([^\x00\n ]+)(.*)/.exec(text);
        if (!m) continue;
        refs.set(m[2], m[1]);
        if (m[2] === "HEAD") head = m[1];
        if (m[3].startsWith("\x00")) {
          caps = new Set(m[3].slice(1).split(" "));
          for (const cap of caps) {
            if (cap.startsWith("symref=HEAD:")) symref = cap.slice("symref=HEAD:".length);
          }
        }
      }
    } catch { return null; }
    if (refs.size === 0) return null;
    if (!head && symref) head = refs.get(symref) || null;
    return { refs, caps, symref, head };
  }

  async uploadPack(wants, { filter, caps } = {}) {
    const resp = await fetch(this._url("/git-upload-pack"), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-git-upload-pack-request",
        "Accept": "application/x-git-upload-pack-result, */*",
      },
      body: uploadPackRequest(wants, { filter, caps }),
    });
    if (!resp.ok) throw new Error(`git-upload-pack: HTTP ${resp.status}`);
    return extractPack(new Uint8Array(await resp.arrayBuffer()));
  }
}

// Dumb HTTP: plain GETs against a (bare) repo on a static file server.

class DumbHttpTransport {
  constructor(baseUrl, proxy) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.proxy = proxy || "";
  }

  _url(p) { return this.proxy + this.baseUrl + p; }

  async advertisement() {
    let resp;
    try { resp = await fetch(this._url("/info/refs")); } catch { return null; }
    if (!resp.ok) return null;
    let text;
    try { text = await resp.text(); } catch { return null; }
    const refs = new Map();
    for (const line of text.split("\n")) {
      const m = /^([0-9a-f]{40})\t(\S+)$/.exec(line);
      if (m) refs.set(m[2], m[1]);
    }
    if (refs.size === 0) return null;
    let head = refs.get("HEAD") || null;
    if (!head) {
      try {
        const hresp = await fetch(this._url("/HEAD"));
        if (hresp.ok) {
          const h = (await hresp.text()).trim();
          const m = /^ref: (.+)$/.exec(h);
          head = m ? refs.get(m[1]) || null : (/^[0-9a-f]{40}$/.test(h) ? h : null);
        }
      } catch {}
    }
    return { refs, caps: new Set(), symref: null, head };
  }

  async readLoose(sha) {
    let resp;
    try {
      resp = await fetch(this._url(`/objects/${sha.slice(0, 2)}/${sha.slice(2)}`));
    } catch { return null; }
    if (!resp.ok) return null;
    return new Uint8Array(await resp.arrayBuffer());
  }

  async packNames() {
    let resp;
    try { resp = await fetch(this._url("/objects/info/packs")); } catch { return []; }
    if (!resp.ok) return [];
    const names = [];
    for (const line of (await resp.text()).split("\n")) {
      const m = /^P (.+\.pack)$/.exec(line);
      if (m) names.push(m[1]);
    }
    return names;
  }

  async readPack(name) {
    const resp = await fetch(this._url("/objects/pack/" + name));
    if (!resp.ok) throw new Error("dumb http: pack not found: " + name);
    return new Uint8Array(await resp.arrayBuffer());
  }
}

// ─── GitRepo: object store for one repository ─────────────────

class GitRepo {
  constructor(baseUrl, proxy) {
    this.baseUrl = baseUrl;
    this.proxy = proxy || "";
    this.transport = null;
    this.ad = null;
    this.lazyObjects = false;   // server allows wanting arbitrary shas
    this.branchFetched = false; // full-branch pack already downloaded
    this.objects = new Map();   // sha → { type, data }
    this._loading = new Map();  // sha → in-flight promise
    this._scannedPacks = new Set();  // pack names already parsed & cached
  }

  async advertise() {
    if (this.ad) return this.ad;
    const smart = new SmartHttpTransport(this.baseUrl, this.proxy);
    let ad = await smart.advertisement();
    if (ad) {
      this.transport = smart;
    } else {
      const dumb = new DumbHttpTransport(this.baseUrl, this.proxy);
      ad = await dumb.advertisement();
      if (ad) this.transport = dumb;
      else throw new Error(`not a git repository: ${this.baseUrl}`);
    }
    this.ad = ad;
    this.lazyObjects = ad.caps.has("allow-tip-sha1-in-want");
    return ad;
  }

  async headSha() {
    const ad = await this.advertise();
    if (!ad.head) throw new Error("ENOENT: repository has no HEAD");
    return ad.head;
  }

  // Capabilities to ask for in a want line, limited to what the server
  // advertised. allow-tip-sha1-in-want lets us want arbitrary object ids
  // (trees/blobs), which is what makes per-object lazy fetching possible.
  _wantCaps() {
    const caps = [];
    if (this.ad && this.ad.caps.has("allow-tip-sha1-in-want")) caps.push("allow-tip-sha1-in-want");
    return caps;
  }

  peekObject(sha) {
    return this.objects.get(sha) || null;
  }

  async readObject(sha) {
    const hit = this.objects.get(sha);
    if (hit) return hit;
    if (this._loading.has(sha)) return this._loading.get(sha);
    const p = this._fetchObject(sha).then(
      (obj) => { this.objects.set(sha, obj); this._loading.delete(sha); return obj; },
      (err) => { this._loading.delete(sha); throw err; }
    );
    this._loading.set(sha, p);
    return p;
  }

  async _fetchObject(sha) {
    // Servers that advertise allow-tip-sha1-in-want (GitHub does) let us
    // want any object id — fetch trees/blobs one tiny pack at a time.
    if (this.transport instanceof SmartHttpTransport && this.lazyObjects) {
      const pack = await this.transport.uploadPack([sha], { caps: this._wantCaps() });
      const objs = await parsePack(pack, (baseSha) => this.readObject(baseSha));
      for (const o of objs) this.objects.set(o.sha, o);
      const want = this.objects.get(sha);
      if (!want) throw new Error(`object not in pack: ${sha}`);
      return want;
    }
    // Otherwise fetch the whole branch once (all reachable objects), which
    // works on every server; subsequent reads hit the cache.
    if (!this.branchFetched) {
      const head = await this.headSha();
      let pack;
      if (this.transport instanceof SmartHttpTransport) {
        pack = await this.transport.uploadPack([head], { caps: this._wantCaps() });
      } else {
        // Dumb HTTP: try loose object first (recent objects are loose),
        // else pull every packfile.
        const zlibData = await this.transport.readLoose(sha);
        if (zlibData) {
          const obj = await parseLooseObject(zlibData);
          this.objects.set(sha, obj);
          return obj;
        }
        pack = null;
      }
      this.branchFetched = true;
      if (pack) {
        const objs = await parsePack(pack, (baseSha) => this.readObject(baseSha));
        for (const o of objs) this.objects.set(o.sha, o);
        const want = this.objects.get(sha);
        if (want) return want;
      }
      // Dumb HTTP without a usable pack: scan packfiles for the object.
      return this._scanPacks(sha);
    }
    // Branch already fetched but this object still missing (dumb HTTP):
    // fall through to packfile scanning.
    return this._scanPacks(sha);
  }

  // Dumb HTTP: look the object up in loose storage, else parse every
  // packfile (each pack parsed at most once; all its objects cached).
  async _scanPacks(sha) {
    const zlibData = await this.transport.readLoose(sha);
    if (zlibData) {
      const obj = await parseLooseObject(zlibData);
      this.objects.set(sha, obj);
      return obj;
    }
    const names = await this.transport.packNames();
    for (const name of names) {
      if (this._scannedPacks.has(name)) continue;
      this._scannedPacks.add(name);
      const p = await this.transport.readPack(name);
      const objs = await parsePack(p, (baseSha) => this.readObject(baseSha));
      for (const o of objs) this.objects.set(o.sha, o);
      if (this.objects.has(sha)) return this.objects.get(sha);
    }
    throw new Error(`object not found: ${sha}`);
  }
}

// ─── GitFS: the filesystem backend ────────────────────────────

export class GitFS {
  constructor(options = {}) {
    this.proxy = options.proxy || "";
    this.repos = new Map();   // baseUrl → GitRepo
    this.splits = new Map();  // "host/rest..." → { repo, filePath } | { fail }
    this.visited = new Set(); // paths the user has actually seen (for locate)
  }

  // Return visited paths as a flat list, for locate
  async listVisited() {
    return [...this.visited].sort();
  }

  _parse(relative) {
    const parts = relative.replace(/^\//, "").split("/").filter(Boolean);
    if (parts.length === 0) return { root: true };
    if (parts.length === 1 && parts[0].includes(".")) return { file: parts[0] };
    if (parts.length === 1) return { host: parts[0] };
    return { host: parts[0], rest: parts.slice(1) };
  }

  _baseUrl(host, repoPath) {
    const scheme = /^localhost|^127\.|^192\.168\.|^10\.|^0\.0\.0\.0/.test(host) ? "http" : "https";
    return `${scheme}://${host}/${repoPath}`;
  }

  _repo(url) {
    let r = this.repos.get(url);
    if (!r) { r = new GitRepo(url, this.proxy); this.repos.set(url, r); }
    return r;
  }

  // Find the longest repo path that advertises (handles GitLab subgroup
  // paths), leaving the rest as the file path inside the repo.
  async _resolve(host, rest) {
    const key = host + "/" + rest.join("/");
    const hit = this.splits.get(key);
    if (hit) {
      if (hit.fail) throw new Error("ENOENT: no git repository at this path");
      return hit;
    }
    for (let i = rest.length; i >= 1; i--) {
      const repoPath = rest.slice(0, i).join("/");
      const filePath = rest.slice(i).join("/");
      for (const candidate of [repoPath, repoPath + ".git"]) {
        const url = this._baseUrl(host, candidate);
        const repo = this._repo(url);
        try {
          await repo.advertise();
          const result = { repo, filePath };
          this.splits.set(key, result);
          return result;
        } catch {}
      }
    }
    this.splits.set(key, { fail: true });
    throw new Error("ENOENT: no git repository at this path");
  }

  async _headTree(repo) {
    const commitSha = await repo.headSha();
    const commit = await repo.readObject(commitSha);
    if (commit.type !== "commit") throw new Error("HEAD is not a commit");
    const { tree } = parseCommit(commit.data);
    if (!tree) throw new Error("commit has no tree");
    return tree;
  }

  // Walk filePath ("a/b/c") down from treeSha; returns { sha, mode }.
  async _walk(repo, treeSha, filePath) {
    let sha = treeSha;
    let mode = 0o40000;
    for (const part of filePath.split("/")) {
      if (!part) continue;
      const obj = await repo.readObject(sha);
      if (obj.type !== "tree") throw new Error("ENOTDIR: " + part);
      const entry = parseTree(obj.data).find(en => en.name === part);
      if (!entry) throw new Error("ENOENT: " + part);
      sha = entry.sha;
      mode = entry.mode;
    }
    return { sha, mode };
  }

  async _commitDate(repo) {
    try {
      const commitSha = await repo.headSha();
      const commit = await repo.readObject(commitSha);
      return parseCommit(commit.data).committerDate;
    } catch { return undefined; }
  }

  // ─── Directory listing ──────────────────────────────────────

  async list(path) {
    const p = this._parse(path);

    if (p.root || p.file) return this._rootListing(p);
    if (p.host && !p.rest) return this._hostListing(p.host);

    const { repo, filePath } = await this._resolve(p.host, p.rest);
    const full = p.rest.join("/");
    this.visited.add(`/${p.host}/${full}/`);

    const tree = await this._headTree(repo);
    const entry = filePath
      ? await this._walk(repo, tree, filePath)
      : { sha: tree, mode: 0o40000 };
    const obj = await repo.readObject(entry.sha);
    if (obj.type !== "tree") throw new Error("EISDIR: not a directory");

    const entries = parseTree(obj.data);
    for (const e of entries) {
      this.visited.add(`/${p.host}/${full}/${e.name}` + (e.mode === 0o40000 ? "/" : ""));
    }
    return entries
      .map(e => (e.mode === 0o40000 ? e.name + "/" : e.name))
      .sort();
  }

  // ─── File reading ───────────────────────────────────────────

  async _blobEntry(path) {
    const p = this._parse(path);
    if (p.file === "README.md" || p.file === ".readme") {
      return { readme: true };
    }
    if (!p.rest || !p.rest.length) throw new Error("EISDIR: not a file");
    const { repo, filePath } = await this._resolve(p.host, p.rest);
    if (!filePath) throw new Error("EISDIR: not a file");
    const tree = await this._headTree(repo);
    const entry = await this._walk(repo, tree, filePath);
    const obj = await repo.readObject(entry.sha);
    if (obj.type === "tree") throw new Error("EISDIR: not a file");
    this.visited.add(`/${p.host}/${p.rest.join("/")}`);
    return { repo, entry, obj };
  }

  async read(path) {
    const b = await this._blobEntry(path);
    if (b.readme) return this._readme();
    if (b.entry.mode === 0o160000) return b.entry.sha + "\n";  // submodule pointer
    return dec.decode(b.obj.data);
  }

  async readBlob(path) {
    const b = await this._blobEntry(path);
    if (b.readme) return new Blob([this._readme()], { type: "text/plain" });
    return new Blob([b.obj.data], { type: "application/octet-stream" });
  }

  // ─── stat ───────────────────────────────────────────────────

  async stat(path) {
    const p = this._parse(path);
    if (p.root || p.file || (p.host && !p.rest)) {
      return { type: "dir", size: 0, mtime: undefined };
    }
    const { repo, filePath } = await this._resolve(p.host, p.rest);
    const tree = await this._headTree(repo);
    const mtime = await this._commitDate(repo);
    const entry = filePath
      ? await this._walk(repo, tree, filePath)
      : { sha: tree, mode: 0o40000 };
    if (entry.mode === 0o40000) return { type: "dir", size: 0, mtime };
    // Don't fetch the blob just to learn its size — report it if cached.
    const cached = repo.peekObject(entry.sha);
    return { type: "file", size: cached ? cached.data.length : undefined, mtime, mode: entry.mode };
  }

  async write(path, content) {
    throw new Error("EROFS: git repos are read-only (use git push)");
  }

  async remove(path) {
    throw new Error("EROFS: git repos are read-only");
  }

  // ─── Root / host listings and README ────────────────────────

  _rootListing(p) {
    const hosts = [...new Set(FEATURED.map(f => f.host))].sort();
    return [...hosts.map(h => h + "/"), "...", "README.md"];
  }

  _hostListing(host) {
    const repos = FEATURED.filter(f => f.host === host).map(f => f.path + "/");
    return [...repos, "...", "README.md"];
  }

  async _readme() {
    let text = `Git Filesystem
===============

Mount any git repository as a filesystem — real git, no API. This backend
reads the git wire protocol directly: commits, trees, blobs, and packfiles
(ofs-delta / ref-delta included).

Usage:
  ls /mount/git/github.com/gmatht/sh2perl/
  ls /mount/git/github.com/gmatht/sh2perl/src/fs/
  cat /mount/git/github.com/gmatht/sh2perl/README.md
  ls /mount/git/gitlab.com/group/subgroup/repo/

Any public repo works:  /mount/git/{host}/{repo-path}/{file-path}
GitLab subgroup paths are handled automatically.

Implementation notes:
  - Smart HTTP (git-upload-pack) by default; falls back to dumb HTTP for
    static file servers serving a bare repo (local testing).
  - Objects are fetched lazily — one small request per object. A directory
    listing downloads only the trees it needs, never the file contents.
  - In the browser, git hosts don't send CORS headers, so the mount needs a
    CORS proxy: new GitFS({ proxy: "https://cors.example/" }). The Node CLI
    works directly against GitHub etc.

Featured repos:\n`;
    for (const f of FEATURED) {
      text += `  ${f.host}/${f.path}  — ${f.desc}\n`;
    }
    return text;
  }

  // Resolve a virtual path to the underlying repo's base URL (for
  // `browse`), or null if it doesn't point into a repository.
  async browseUrl(path) {
    const p = this._parse(path);
    if (!p.host || !p.rest || !p.rest.length) return null;
    try {
      const { repo } = await this._resolve(p.host, p.rest);
      return repo.baseUrl;
    } catch { return null; }
  }
}
