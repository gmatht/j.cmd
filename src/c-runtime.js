// ─── C runtime: the env module for qbe2wasm-compiled C programs ──
//
// cproc → QBE IR → qbe2wasm produces a bare wasm module whose extern
// calls (`call extern $f`) become imports of the `env` module. This
// provides a practical libc subset in JS — printf/puts/putchar output,
// a bump heap for malloc/free, the usual string/memory functions and
// exit — so `cc prog.c && ./a.wasm` actually runs.
//
// Memory layout (qbe2wasm): static data + the stack pointer global sit
// at the bottom of linear memory (the stack grows up from there). The
// heap starts at the END of the initial memory and grows upward via
// memory.grow, so the stack and heap never meet for small programs.
// -----------------------------------------------------------------

// Program-exit marker — thrown by $exit/$abort, caught by the shell runner.
export class CExit extends Error {
  constructor(code) { super("exit(" + code + ")"); this.name = "CExit"; this.code = code; }
}

export function createCRuntime({ getMem, memory, out, err, table }) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // QBE 'l' pointer args arrive as i64 wasm params (BigInt); wasm32
  // addresses are i32 — coerce.
  const Ptr = (v) => Number(v);

  // Fresh view of the CURRENT memory buffer (grow() invalidates views).
  const u8 = () => getMem();
  const readStr = (p) => {
    p = Ptr(p);
    const m = u8();
    let e = p;
    while (m[e] !== 0) e++;
    return dec.decode(m.subarray(p, e));
  };
  const writeStr = (p, s) => {
    p = Ptr(p);
    const b = enc.encode(s);
    const m = u8();
    m.set(b, p);
    m[p + b.length] = 0;
    return p;
  };

  // ─── heap ──────────────────────────────────────────────────
  let heapTop = null;
  const pageSize = 65536;
  function heapBase() {
    if (heapTop === null) heapTop = memory().buffer.byteLength;
    return heapTop;
  }
  function growHeap(need) {
    heapBase();  // lazily fix the heap base on the first allocation
    const cur = memory().buffer.byteLength;
    const want = heapTop + need;
    if (want > cur) {
      const pages = Math.ceil((want - cur) / pageSize);
      if (memory().grow(pages) === -1) return -1;
    }
    const p = heapTop;
    heapTop = Math.ceil((heapTop + need) / 8) * 8;
    return p;
  }

  // ─── printf: %d %i %u %x %X %c %s %f %ld %zu %% ─────────────
  function fmtInt(v, base, pad, upper) {
    const digits = upper ? "0123456789ABCDEF" : "0123456789abcdef";
    let s = v.toString(base);
    while (s.length < pad) s = "0" + s;
    return upper ? s : s;
  }
  function doPrintf(fmtPtr, args, to) {
    const fmt = readStr(fmtPtr);
    let out = "", ai = 0;
    for (let i = 0; i < fmt.length; i++) {
      const ch = fmt[i];
      if (ch !== "%") { out += ch; continue; }
      i++;
      let conv = fmt[i];
      // length modifiers we ignore (l, ll, z, h)
      while (conv === "l" || conv === "h" || conv === "z" || conv === "j") conv = fmt[++i];
      if (conv === undefined) break;
      const arg = () => args[ai++];
      switch (conv) {
        case "%": out += "%"; break;
        case "d": case "i": out += String(arg()); break;
        case "u": out += String(arg() >>> 0); break;
        case "x": out += fmtInt(arg() >>> 0, 16, 0, false); break;
        case "X": out += fmtInt(arg() >>> 0, 16, 0, true); break;
        case "o": out += fmtInt(arg() >>> 0, 8, 0, false); break;
        case "c": out += String.fromCharCode(arg()); break;
        case "s": {
          const p = arg();
          out += p ? readStr(p) : "(null)";
          break;
        }
        case "f": out += arg().toFixed(6).replace(/\.?0+$/, ""); break;
        case "p": out += "0x" + fmtInt(arg() >>> 0, 16, 0, false); break;
        default: out += "%" + conv;
      }
    }
    to(out);
    return out.length;
  }

  // ─── qsort/bsearch: callbacks through the module's function table ──
  // C function pointers are table indices. The guest passes the compar
  // as `l extern $cmp` (lowered to its table index by qbe2wasm); the
  // table export (__indirect_function_table) resolves it back to code.
  // `table()` is a lazy accessor — the wasm runner fills it after
  // instantiation (the same memRef pattern as memory).
  const callFnPtr = (fnPtr, ...args) => {
    const tbl = table ? table() : null;
    if (!tbl) throw new Error("env: function pointer call but no function table");
    const fn = tbl.get(Ptr(fnPtr));
    if (typeof fn !== "function") throw new Error(`env: bad function pointer ${Ptr(fnPtr)}`);
    // QBE 'l' (i64) args need BigInt; wasm32 compar functions take
    // plain numbers — try BigInt first, fall back on the TypeError.
    try { return Number(fn(...args.map((a) => BigInt(a)))); }
    catch (e1) {
      if (process.env.QSORT_DEBUG) err("QSortDbg bigint call failed: " + e1.message + " args=" + JSON.stringify(args.map(String)) + "\n");
      try { return Number(fn(...args.map((a) => Number(a)))); }
      catch (e2) { if (process.env.QSORT_DEBUG) err("QSortDbg number call failed: " + e2.message + "\n"); throw e2; }
    }
  };

  return {
    "$qsort": (base, nmemb, size, compar) => {
      base = Ptr(base); nmemb = Ptr(nmemb); size = Ptr(size); compar = Ptr(compar);
      if (nmemb <= 1 || size <= 0) return;
      const m8 = () => u8();
      const elem = (i) => base + i * size;
      const cmp = (i, j) => callFnPtr(compar, elem(i), elem(j));
      const swap = (i, j) => {
        if (i === j) return;
        const m = m8();
        const a = elem(i), b = elem(j);
        for (let k = 0; k < size; k++) { const t = m[a + k]; m[a + k] = m[b + k]; m[b + k] = t; }
      };
      const stack = [[0, nmemb - 1]];   // iterative — no deep recursion
      while (stack.length) {
        const [lo, hi] = stack.pop();
        if (lo >= hi) continue;
        let i = lo;
        for (let j = lo; j < hi; j++) {
          if (cmp(j, hi) <= 0) { swap(i, j); i++; }
        }
        swap(i, hi);
        stack.push([lo, i - 1], [i + 1, hi]);
      }
    },
    "$bsearch": (key, base, nmemb, size, compar) => {
      base = Ptr(base); nmemb = Ptr(nmemb); size = Ptr(size); compar = Ptr(compar);
      if (nmemb <= 0 || size <= 0) return 0;
      const elem = (i) => base + i * size;
      let lo = 0, hi = nmemb;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const c = callFnPtr(compar, Ptr(key), elem(mid));   // (key, element)
        if (c < 0) lo = mid + 1;
        else if (c > 0) hi = mid;
        else return elem(mid);
      }
      return 0;
    },

    "$printf": (fmt, ...args) => doPrintf(Ptr(fmt), args, out),
    "$puts": (p) => { out(readStr(p) + "\n"); return 0; },
    "$freopen": (name, mode, stream) => stream,  // reopen a stream — sandbox: keep it
    "$setvbuf": (stream, buf, mode, size) => 0,   // buffer mode — sandbox: no-op
    "$putchar": (c) => { out(String.fromCharCode(c)); return c; },
    "$fprintf": (stream, fmt, ...args) => doPrintf(Ptr(fmt), args, out),
    "$sprintf": (dst, fmt, ...args) => { dst = Ptr(dst);
      const s = [];
      doPrintf(fmt, args, (t) => s.push(t));
      writeStr(dst, s.join(""));
      return s.join("").length;
    },

    "$malloc": (size) => growHeap(Ptr(size)),
    "$calloc": (n, size) => { n = Ptr(n); size = Ptr(size);
      const p = growHeap((n * size) | 0);
      if (p === -1) return 0;
      u8().fill(0, p, p + n * size);
      return p;
    },
    "$realloc": (p, size) => { /* no move tracking — leak; fine for demos */ return p; },
    "$free": () => {},

    "$strlen": (p) => readStr(p).length,
    "$strcmp": (a, b) => { a = Ptr(a); b = Ptr(b);
      const sa = readStr(a), sb = readStr(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    },
    "$strcpy": (d, s) => { d = Ptr(d); s = Ptr(s); const m = u8(); let i = 0; while (m[s + i]) { m[d + i] = m[s + i]; i++; } m[d + i] = 0; return d; },
    "$strncpy": (d, s, n) => { d = Ptr(d); s = Ptr(s); n = Ptr(n);
      const m = u8();
      for (let i = 0; i < n; i++) { const c = m[s + i] || 0; m[d + i] = c; if (!c) break; }
      return d;
    },
    "$strcat": (d, s) => { d = Ptr(d); s = Ptr(s);
      const m = u8();
      let i = 0;
      while (m[d + i]) i++;
      let j = 0;
      while (m[s + j]) { m[d + i + j] = m[s + j]; j++; }
      m[d + i + j] = 0;
      return d;
    },
    "$memcpy": (d, s, n) => { d = Ptr(d); s = Ptr(s); n = Ptr(n); const m = u8(); m.set(m.subarray(s, s + n), d); return d; },
    "$memmove": (d, s, n) => { d = Ptr(d); s = Ptr(s); n = Ptr(n); const m = u8(); m.set(m.slice(s, s + n), d); return d; },
    "$memset": (d, c, n) => { d = Ptr(d); c = Ptr(c); n = Ptr(n); u8().fill(c & 0xff, d, d + n); return d; },
    "$memcmp": (a, b, n) => { a = Ptr(a); b = Ptr(b); n = Ptr(n);
      const m = u8();
      for (let i = 0; i < n; i++) {
        if (m[a + i] !== m[b + i]) return m[a + i] - m[b + i];
      }
      return 0;
    },

    "$exit": (code) => { throw new CExit(Ptr(code)); },
    "$abort": () => { err("abort() called\n"); throw new CExit(134); },
    "$__assert_fail": () => { err("assertion failed\n"); throw new CExit(134); },
  };
}
