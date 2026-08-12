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

  // ─── printf: %d %i %u %x %X %o %c %s %f %g %e %p %ld %zu %% ──────
  function fmtInt(v, base, pad, upper) {
    // JS toString(base) is always lowercase — %X/%o need the table
    const digits = upper ? "0123456789ABCDEF" : "0123456789abcdef";
    let s = "";
    do { s = digits[v % base] + s; v = Math.floor(v / base); } while (v > 0);
    while (s.length < pad) s = "0" + s;
    return s;
  }
  // pad a signed integer string: C puts the zero-padding AFTER the sign
  function padNum(s, width, zero) {
    if (s.length >= width) return s;
    const neg = s[0] === "-";
    const body = neg ? s.slice(1) : s;
    const padCh = zero ? "0" : " ";
    const p = padCh.repeat(Math.max(0, width - s.length));
    return (neg ? "-" : "") + (zero ? p + body : p + s);
  }
  function fmtF(v, prec) {
    // %f always prints the precision (default 6) — never strips zeros
    return v.toFixed(prec < 0 ? 6 : prec);
  }
  function fmtG(v, prec) {
    // C %g: %f-like but strips trailing zeros (exponent form when the
    // exponent is < -4 or >= precision — simplified to the strip)
    if (v === 0) return "0";
    const p = prec < 0 ? 6 : (prec === 0 ? 1 : prec);
    let s = v.toPrecision(p);
    s = s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    return s;
  }
  function doPrintf(fmtPtr, args, to) {
    const fmt = readStr(fmtPtr);
    let out = "", ai = 0;
    for (let i = 0; i < fmt.length; i++) {
      const ch = fmt[i];
      if (ch !== "%") { out += ch; continue; }
      i++;
      // flags: -, +, space, 0, #
      let zero = false, left = false;
      for (;;) {
        const f = fmt[i];
        if (f === "0") zero = true;
        else if (f === "-") left = true;
        else if (f === "+" || f === " " || f === "#") { /* ignored */ }
        else break;
        i++;
      }
      // width
      let width = 0;
      while (fmt[i] >= "0" && fmt[i] <= "9") width = width * 10 + (fmt.charCodeAt(i++) - 48);
      // precision
      let prec = -1;
      if (fmt[i] === ".") { i++; prec = 0; while (fmt[i] >= "0" && fmt[i] <= "9") prec = prec * 10 + (fmt.charCodeAt(i++) - 48); }
      // length modifiers we ignore (l, ll, z, h, j, t, L)
      while (fmt[i] === "l" || fmt[i] === "h" || fmt[i] === "z" || fmt[i] === "j" || fmt[i] === "t" || fmt[i] === "L") i++;
      const conv = fmt[i];
      if (conv === undefined) break;
      const arg = () => args[ai++];
      const wid = (s) => left ? s.padEnd(width) : padNum(s, width, zero);
      switch (conv) {
        case "%": out += "%"; break;
        case "d": case "i": {
          let v = arg();
          if (typeof v === "bigint") v = Number(v);
          out += wid(String(v)); break;
        }
        case "u": out += wid(String(arg() >>> 0)); break;
        case "x": out += wid(fmtInt(arg() >>> 0, 16, 0, false)); break;
        case "X": out += wid(fmtInt(arg() >>> 0, 16, 0, true)); break;
        case "o": out += wid(fmtInt(arg() >>> 0, 8, 0, false)); break;
        case "c": out += String.fromCharCode(arg()); break;
        case "s": {
          const p = arg();
          let s = p ? readStr(p) : "(null)";
          if (prec >= 0) s = s.slice(0, prec);
          out += wid(s);
          break;
        }
        case "f": {
          let v = arg(); if (typeof v === "bigint") v = Number(v);
          out += wid(fmtF(v, prec)); break;
        }
        case "g": case "G": {
          let v = arg(); if (typeof v === "bigint") v = Number(v);
          out += wid(fmtG(v, prec)); break;
        }
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

  // atexit/on_exit: table-index handlers run at exit (reverse order) —
  // both on `exit()` and on normal main return (the runner flushes
  // via the exported flushAtexit hook).
  const atexitFns = [];
  const runAtexit = () => {
    while (atexitFns.length) {
      const e = atexitFns.pop();
      if (Array.isArray(e)) callFnPtr(e[0], e[1], 0);
      else callFnPtr(e, 0);
    }
  };

  const rt = {
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
    "$write": (fd, buf, len) => { buf = Ptr(buf); len = Ptr(len);
      const m = u8();
      const text = dec.decode(m.subarray(buf, buf + len));
      if (Ptr(fd) === 2) err(text); else out(text);
      return len;
    },
    "$fflush": () => 0,  // output is unbuffered — nothing to flush
    "$fopen": () => 0,   // no synchronous FS in the sandbox — NULL
    "$fdopen": () => 0,
    "$fclose": () => 0,
    "$fread": () => 0,
    "$fwrite": () => 0,
    "$fgets": () => 0,
    "$fputs": () => -1,
    "$fputc": () => -1,
    "$fgetc": () => -1,
    "$fseek": () => -1,
    "$ftell": () => 0,
    "$feof": () => 1,
    "$ferror": () => 0,
    "$remove": () => -1,
    "$rename": () => -1,
    "$rewind": () => {},
    // tcc math builtins → IEEE doubles in JS
    "$sin": (x) => Math.sin(x), "$cos": (x) => Math.cos(x), "$tan": (x) => Math.tan(x),
    "$sqrt": (x) => Math.sqrt(x), "$pow": (x, y) => Math.pow(x, y),
    "$fabs": (x) => Math.abs(x), "$floor": (x) => Math.floor(x), "$ceil": (x) => Math.ceil(x),
    "$exp": (x) => Math.exp(x), "$log": (x) => Math.log(x), "$log10": (x) => Math.log10(x),
    "$atan2": (x, y) => Math.atan2(x, y), "$fmod": (x, y) => x % y,
    "$asin": (x) => Math.asin(x), "$acos": (x) => Math.acos(x),
    "$atan": (x) => Math.atan(x), "$sinh": (x) => Math.sinh(x), "$cosh": (x) => Math.cosh(x),
    "$tanh": (x) => Math.tanh(x), "$fmin": (x, y) => Math.min(x, y), "$fmax": (x, y) => Math.max(x, y),
    "$round": (x) => Math.sign(x) * Math.round(Math.abs(x)),
    "$trunc": (x) => Math.trunc(x), "$lround": (x) => Math.sign(x) * Math.round(Math.abs(x)),
    "$labs": (x) => Math.abs(x), "$llabs": (x) => Math.abs(x),
    "$ldexp": (x, e) => x * Math.pow(2, e), "$frexp": (x) => { if (x === 0) return 0; const e = Math.floor(Math.log2(Math.abs(x))) + 1; return e; },
    // tcc __atomic_* builtins: 4-byte ops over the linear memory
    "$__atomic_load_4": (p) => { p = Ptr(p); const m = u8();
      return m[p] | (m[p + 1] << 8) | (m[p + 2] << 16) | (m[p + 3] << 24); },
    "$__atomic_store_4": (p, v) => { p = Ptr(p); v = Ptr(v); const m = u8();
      m[p] = v & 0xff; m[p + 1] = (v >> 8) & 0xff; m[p + 2] = (v >> 16) & 0xff; m[p + 3] = (v >> 24) & 0xff;
      return v; },
    "$__atomic_exchange_4": (p, v) => { p = Ptr(p); v = Ptr(v);
      const m = u8();
      const old = m[p] | (m[p + 1] << 8) | (m[p + 2] << 16) | (m[p + 3] << 24);
      m[p] = v & 0xff; m[p + 1] = (v >> 8) & 0xff; m[p + 2] = (v >> 16) & 0xff; m[p + 3] = (v >> 24) & 0xff;
      return old; },
    "$__atomic_compare_exchange_4": (p, expected, desired, weak, succ, fail) => {
      p = Ptr(p); expected = Ptr(expected); desired = Ptr(desired);
      const m = u8();
      const cur = m[p] | (m[p + 1] << 8) | (m[p + 2] << 16) | (m[p + 3] << 24);
      const exp = m[expected] | (m[expected + 1] << 8) | (m[expected + 2] << 16) | (m[expected + 3] << 24);
      if (cur === exp) {
        m[p] = desired & 0xff; m[p + 1] = (desired >> 8) & 0xff; m[p + 2] = (desired >> 16) & 0xff; m[p + 3] = (desired >> 24) & 0xff;
        return 1;
      }
      m[expected] = cur & 0xff; m[expected + 1] = (cur >> 8) & 0xff; m[expected + 2] = (cur >> 16) & 0xff; m[expected + 3] = (cur >> 24) & 0xff;
      return 0;
    },
    "$__atomic_fetch_add_4": (p, v) => { p = Ptr(p); v = Ptr(v); const m = u8();
      const old = m[p] | (m[p + 1] << 8) | (m[p + 2] << 16) | (m[p + 3] << 24);
      const nv = (old + v) | 0;
      m[p] = nv & 0xff; m[p + 1] = (nv >> 8) & 0xff; m[p + 2] = (nv >> 16) & 0xff; m[p + 3] = (nv >> 24) & 0xff;
      return old; },
    // pthread stubs (single-threaded sandbox)
    "$pthread_condattr_init": () => 0,
    "$pthread_condattr_setpshared": () => 0,
    "$pthread_condattr_setclock": () => 0,
    "$pthread_condattr_destroy": () => 0,
    "$pthread_condattr_getpshared": () => 0,
    "$pthread_cond_init": () => 0,
    "$pthread_mutex_init": () => 0,
    "$pthread_mutexattr_init": () => 0,
    "$pthread_mutexattr_settype": () => 0,
    "$pthread_create": () => 1,
    "$pthread_join": () => 0,
    "$pthread_self": () => 0,
    "$pthread_mutex_lock": () => 0,
    "$pthread_mutex_unlock": () => 0,
    "$pthread_cond_wait": () => 0,
    "$pthread_cond_signal": () => 0,
    "$pthread_cond_broadcast": () => 0,
    // tcc test-suite hooks (linker/backtrace/dso helpers)
    "$tcc_backtrace": () => {},
    "$get_dso_end": () => 0,
    "$check_linker_symbols": () => 0,
    // 104_inline: predeclared static-inline functions that the wasm32
    // backend emits as env imports instead of local definitions — a
    // no-op keeps the call sites harmless.
    "$noinst_static_inline_predeclared": () => 0,
    "$noinst2_static_inline_predeclared": () => 0,
    "$noinst_static_inline_postdeclared": () => 0,
    "$noinst2_static_inline_postdeclared": () => 0,
    "$alias_for_target": () => 0,
    "$target": () => 0,
    "$asm_for_target": () => 0,
    "$f_1": () => 0,
    "$f_2": () => 0,
    "$inunit2": () => 0,
    "$inline_inline_undeclared": () => 0,
    "$inline_inline_predeclared": () => 0,
    "$inline_inline_postdeclared": () => 0,
    "$inline_inline_undeclared2": () => 0,
    "$inline_inline_predeclared2": () => 0,
    "$inline_inline_postdeclared2": () => 0,
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
    "$strncmp": (a, b, n) => { a = Ptr(a); b = Ptr(b); n = Ptr(n);
      const m = u8();
      for (let i = 0; i < n; i++) {
        const ca = m[a + i], cb = m[b + i];
        if (ca !== cb) return ca - cb;
        if (ca === 0) return 0;
      }
      return 0;
    },
    "$strcasecmp": (a, b) => { a = Ptr(a); b = Ptr(b);
      const sa = readStr(a).toLowerCase(), sb = readStr(b).toLowerCase();
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    },
    "$strncasecmp": (a, b, n) => { a = Ptr(a); b = Ptr(b); n = Ptr(n);
      const sa = readStr(a).toLowerCase().slice(0, n);
      const sb = readStr(b).toLowerCase().slice(0, n);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    },
    "$strchr": (p, c) => { p = Ptr(p); c = Ptr(c); const m = u8();
      const ch = c & 0xff;
      let i = p;
      for (;;) { const b = m[i]; if (b === ch) return i; if (b === 0) return 0; i++; }
    },
    "$strstr": (h, n) => { h = Ptr(h); n = Ptr(n);
      const hay = readStr(h), needle = readStr(n);
      const i = hay.indexOf(needle);
      return i < 0 ? 0 : h + i;
    },
    "$strrchr": (p, c) => { p = Ptr(p); c = Ptr(c);
      const s = readStr(p);
      const ch = String.fromCharCode(c & 0xff);
      const i = s.lastIndexOf(ch);
      return i < 0 ? 0 : p + i;
    },
    // ctype
    "$tolower": (c) => { c = Ptr(c); return c >= 65 && c <= 90 ? c + 32 : c; },
    "$toupper": (c) => { c = Ptr(c); return c >= 97 && c <= 122 ? c - 32 : c; },
    "$isalpha": (c) => { c = Ptr(c); return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ? 1 : 0; },
    "$isdigit": (c) => { c = Ptr(c); return c >= 48 && c <= 57 ? 1 : 0; },
    "$isalnum": (c) => { c = Ptr(c); return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ? 1 : 0; },
    "$isspace": (c) => { c = Ptr(c); return c === 32 || (c >= 9 && c <= 13) ? 1 : 0; },
    "$islower": (c) => { c = Ptr(c); return c >= 97 && c <= 122 ? 1 : 0; },
    "$isupper": (c) => { c = Ptr(c); return c >= 65 && c <= 90 ? 1 : 0; },
    "$isprint": (c) => { c = Ptr(c); return c >= 32 && c <= 126 ? 1 : 0; },
    "$strdup": (s) => { s = Ptr(s); const t = readStr(s);
      const p = growHeap(t.length + 1);
      if (p === -1) return 0;
      writeStr(p, t);
      return p;
    },
    "$getc": () => -1, "$getchar": () => -1, "$ungetc": () => -1,
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

    "$exit": (code) => { runAtexit(); throw new CExit(Ptr(code)); },
    "$abort": () => { err("abort() called\n"); throw new CExit(134); },
    "$__assert_fail": () => { err("assertion failed\n"); throw new CExit(134); },
    "$atexit": (fn) => { atexitFns.push(Ptr(fn)); return 0; },
    "$on_exit": (fn, arg) => { atexitFns.push([Ptr(fn), Ptr(arg)]); return 0; },
  };
  // The atexit flush hook (runner calls it after a normal main return).
  rt.flushAtexit = runAtexit;
  return rt;
}
