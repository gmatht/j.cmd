// ─── NetHack — the real game, compiled to WASM, in the shell ─────
//
// NetHack 3.6.7 (apowers313/NetHackJS → the neth4ck monorepo) compiled
// with emscripten: the C game (win/shim window system) drives a single
// async JS callback (Asyncify), so the entire game — map, status,
// messages, menus — is ours to render.
//
//   www/vendor/nethack.js   — emscripten glue (ESM factory)
//   www/vendor/nethack.wasm — the game, 4.9MB (data embedded via
//                             emscripten FS: /nhdat, /sysconf)
//
// The shell command is `nethack`:
//   • browser  — full-screen TTY-style game: status line on top, the
//                dungeon map in the middle, messages at the bottom.
//                Keys come from the shell's key hook; Ctrl+C returns
//                to the prompt (onInterrupt).
//   • CLI/node — `nethack --demo` autoplays a scripted game (tests the
//                whole pipeline headlessly). `nethack` alone prints a
//                hint, since the interactive UI needs a DOM.
//
// The shim callback contract (win/shim/winshim.c, format-string typed):
//   • window ids: WIN_MAP / WIN_STATUS / WIN_MESSAGE / WIN_INVEN
//   • strings arrive as emscripten heap pointers → Module.UTF8ToString
//   • returns: "i" number, "c" char code, "s" string, "v" 0, "b" bool
// -----------------------------------------------------------------

const isNode = typeof process !== "undefined" && process.versions && process.versions.node;
const GLUE_URL = new URL("../www/vendor/nethack.js", import.meta.url).href;
const WASM_URL = new URL("../www/vendor/nethack.wasm", import.meta.url).href;

// NetHack tty colours (CLR_*): 0 black … 15 white, 16 = no colour.
const NH_COLORS = {
  0: "#000000", 1: "#c41a1a", 2: "#2ab32a", 3: "#b58a1e", 4: "#2a2ac4",
  5: "#b01ab0", 6: "#1ab0b0", 7: "#c0c0c0", 8: "#808080", 9: "#ff5050",
  10: "#50ff50", 11: "#ffff50", 12: "#5050ff", 13: "#ff50ff", 14: "#50ffff",
  15: "#ffffff", 16: "#d8d8d8",
};
const colorCss = (c) => NH_COLORS[c] || NH_COLORS[16];

// Status fields in tty display order: [BL_* name, short label].
const STATUS_ORDER = [
  ["BL_TITLE", ""], ["BL_STRENGTH", "St"], ["BL_DEXTERITY", "Dx"],
  ["BL_CONSTITUTION", "Co"], ["BL_INTELLIGENCE", "In"], ["BL_WISDOM", "Wi"],
  ["BL_CHARISMA", "Ch"], ["BL_GOLD", "Gold"], ["BL_HP", "HP"],
  ["BL_ENERGY", "Pw"], ["BL_AC", "AC"], ["BL_XP", "Xp"], ["BL_CAP", "Cap"],
  ["BL_SCORE", "Score"], ["BL_TIME", "Time"], ["BL_CONDITION", ""],
  ["BL_ALIGNMENT", "Align"], ["BL_LEVEL", "Lvl"], ["BL_ENCUMBRANCE", "Enc"],
];

const MAP_W = 80;
const MAP_H = 21;

// ─── Game driver ──────────────────────────────────────────────

export class NethackGame {
  constructor(opts = {}) {
    this.onLog = opts.onLog || (() => {});
    this.autoKeys = opts.keys || null;   // CLI autoplay scripted keys
    this.status = {};                    // BL_* → value string
    this.message = [];                   // message window lines
    this.map = [];                       // MAP_H × MAP_W of {ch, color}
    this.mapDirty = true;
    this.menu = [];                      // {ch, str}
    this.wins = new Map();               // id → {type, kind}
    this._winSeq = 0;
    this._pendingKey = null;             // {resolve}
    this._gameOver = null;               // {resolve}
    this._over = false;
    this._module = null;
  }

  decodeStr(v) {
    let s = "";
    if (typeof v === "number" && v > 100000) {
      try { s = this._module.UTF8ToString(v) || ""; } catch { s = ""; }
    } else {
      s = v == null ? "" : String(v);
    }
    // strip NetHack's internal colour escapes (\G, \C, \O, …) and trim
    return s.replace(/\\([A-Za-z0-9])/g, "").replace(/\x1b\[[0-9;]*m/g, "").trim();
  }

  winKind(win) {
    const w = this.wins.get(win);
    return w ? w.kind : null;
  }

  // ─── The shim callback ─────────────────────────────────────

  async callback(name, ...args) {
    const M = this._module;
    // Quit watchdog: after "Really quit?" the game may exit silently
    // (Asyncify ExitStatus path — onExit is skipped). Any callback
    // activity resets the timer; 3s of silence means the game is done.
    if (this._quitting) {
      clearTimeout(this._quitTimer);
      this._quitTimer = setTimeout(() => this.finish(0), 3000);
    }
    switch (name) {
      case "shim_init_nhwindows":
        return 0;
      case "shim_create_nhwindow": {
        const type = args[0];
        const id = ++this._winSeq;
        let kind = "other";
        if (type === 1) kind = "map";
        else if (type === 3) kind = "status";
        else if (type === 4) kind = "message";
        this.wins.set(id, { type, kind });
        return id;
      }
      case "shim_clear_nhwindow": {
        const kind = this.winKind(args[0]);
        if (kind === "map") { this.map = []; this.mapDirty = true; }
        else if (kind === "message") { this.message = []; }
        else if (kind === "status") { this.status = {}; }
        return 0;
      }
      case "shim_display_nhwindow":
        this.render();
        return 0;
      case "shim_destroy_nhwindow":
        this.wins.delete(args[0]);
        return 0;
      case "shim_curs":
      case "shim_cliparound":
        return 0;
      case "shim_print_glyph": {
        const [, x, y, glyph] = args;
        if (typeof glyph !== "number") return 0;
        let info = { ch: "?", color: 16 };
        try {
          const h = globalThis.nethackGlobal?.helpers?.mapglyphHelper;
          if (h) info = h(glyph, x, y, 0) || info;
        } catch {}
        // ch may be a char code (number) or a one-char string
        if (typeof info.ch === "number") info.ch = String.fromCharCode(info.ch);
        if (!info.ch || info.ch.charCodeAt(0) < 32) info.ch = " ";
        if (x >= 0 && x < MAP_W && y >= 0 && y < MAP_H) {
          if (!this.map[y]) this.map[y] = [];
          this.map[y][x] = { ch: info.ch, color: info.color };
          this.mapDirty = true;
        }
        return 0;
      }
      case "shim_putstr": {
        const [win, , str, append] = args;
        const s = this.decodeStr(str);
        const kind = this.winKind(win) || "message";
        if (kind === "message") {
          if (!append || this.message.length === 0) this.message = [];
          this.message.push(s);
          if (this.message.length > 4) this.message.shift();
        }
        this.render();
        return 0;
      }
      case "shim_raw_print":
      case "shim_raw_print_bold": {
        const s = this.decodeStr(args[0]);
        this.message.push(s);
        if (this.message.length > 4) this.message.shift();
        this.render();
        return 0;
      }
      case "shim_status_init":
        this.status = {};
        return 0;
      case "shim_status_enablefield":
        return 0;
      case "shim_status_update": {
        const fieldIdx = args[0];
        let fieldName = String(fieldIdx);
        try {
          const sf = globalThis.nethackGlobal?.constants?.STATUS_FIELD;
          if (sf && sf[fieldIdx] !== undefined) fieldName = String(sf[fieldIdx]);
        } catch {}
        this.status[fieldName] = this.decodeStr(args[1]);
        this.render();
        return 0;
      }
      case "shim_start_menu":
        this.menu = [];
        return 0;
      case "shim_add_menu": {
        // 367: (win, glyph, attr, ch, str, ident, type) — glyph is an int
        const [, glyph, , ch, str] = args;
        this.menu.push({ ch: typeof ch === "number" ? String.fromCharCode(ch) : ch, str: this.decodeStr(str) });
        return 0;
      }
      case "shim_end_menu":
        this.render();
        return 0;
      case "shim_select_menu":
        // v1: no menu selection — ESC cancels (the game falls back to
        // "shall I pick a character for you?" etc.)
        this.menu = [];
        return 0;
      case "shim_nhgetch":
      case "shim_nh_poskey": {
        if (args.length > 1) {
          for (const p of args) {
            if (typeof p === "number" && p > 0 && p < 100000) {
              try { M.setValue(p, 0, "i32"); } catch {}
            }
          }
        }
        return await this.getKey();
      }
      case "shim_yn_function": {
        const prompt = this.decodeStr(args[0]);
        // end of game: don't play again
        if (/play again/i.test(prompt)) {
          this.finish(0);
          return 110; // 'n'
        }
        // leaving the game: the quit path exits silently after the
        // summary, so arm the watchdog (reset by any later callback)
        if (/really quit/i.test(prompt)) {
          this._quitting = true;
          this._quitTimer = setTimeout(() => this.finish(0), 3000);
        }
        if (this.autoKeys) {
          // demo: quit→yes; skip the end-of-game "do you want…" prompts
          return /really quit/i.test(prompt) ? 121 : 110;
        }
        return await this.getKey();
      }
      case "shim_message_menu":
        if (this.autoKeys) return 13; // enter — auto-advance in demo
        return await this.getKey();
      case "shim_getlin":
        // character-name prompt: return empty → game picks a default
        return 0;
      case "shim_getmsghistory":
        return "";
      case "shim_putmsghistory":
      case "shim_doprev_message":
      case "shim_get_ext_cmd":
      case "shim_ctrl_nhwindow":
      case "shim_mark_synch":
      case "shim_wait_synch":
      case "shim_get_nh_event":
      case "shim_update_inventory":
      case "shim_display_file":
      case "shim_nhbell":
      case "shim_outrip":
      case "shim_start_screen":
      case "shim_end_screen":
      case "shim_suspend_nhwindows":
      case "shim_resume_nhwindows":
      case "shim_exit_nhwindows":
      case "shim_player_selection":
      case "shim_askname":
        // exit_nhwindows is the game's final door (the normal flows reach
        // the "play again?" prompt first); close the command either way —
        // onExit is unreliable through Asyncify's ExitStatus path.
        if (name === "shim_exit_nhwindows") this.finish(0);
        return 0;
      default:
        this.onLog(`nethack: unhandled shim call ${name}`);
        return 0;
    }
  }

  // Wait for a key: browser → fed by the shell's key hook; CLI → scripted.
  getKey() {
    if (this.autoKeys) {
      const k = this.autoKeys.shift();
      if (k !== undefined) return Promise.resolve(k);
      return new Promise(() => {}); // script exhausted → idle
    }
    return new Promise((resolve) => { this._pendingKey = { resolve }; });
  }

  // Feed a key code from the shell. Implements the tty meta-key
  // convention: ESC followed by a key becomes M(key) (0x80 | key) —
  // e.g. ESC q = M('q') = quit. ESC alone cancels after a short window.
  feedKey(code) {
    if (this._escPending) {
      clearTimeout(this._escTimer);
      this._escPending = false;
      code = 0x80 | code;
    } else if (code === 27) { // ESC
      this._escPending = true;
      this._escTimer = setTimeout(() => {
        if (this._escPending) {
          this._escPending = false;
          if (this._pendingKey) {
            const { resolve } = this._pendingKey;
            this._pendingKey = null;
            resolve(27);
          }
        }
      }, 350);
      return false; // claimed only when the follow-up key arrives
    }
    if (this._pendingKey) {
      const { resolve } = this._pendingKey;
      this._pendingKey = null;
      resolve(code);
      return true;
    }
    return false;
  }

  statusLine() {
    const parts = [];
    for (const [field, abbr] of STATUS_ORDER) {
      let v = this.status[field];
      if (v === undefined || v === "") continue;
      v = String(v);
      // BL_GOLD embeds an 8-hex-digit glyph prefix before the amount
      // ("\GXXXXXXXX:NNN" → "NNN") — strip it for display.
      v = v.replace(/^[0-9A-Fa-f]{8}:\d/, (m) => m.slice(9));
      if (field === "BL_TITLE" || field === "BL_CONDITION") { parts.push(v); continue; }
      parts.push(`${abbr}:${v}`);
    }
    return parts.join("  ");
  }

  render() {
    if (this.onRender) this.onRender(this);
  }

  // ─── Module lifecycle ───────────────────────────────────────

  async load() {
    const factory = (await import(GLUE_URL)).default;
    globalThis.nethackGlobal = globalThis.nethackGlobal || {};
    const game = this;
    this._module = await factory({
      noInitialRun: true,
      locateFile: (p) => WASM_URL,
      print: (s) => { game.message.push(String(s)); if (game.message.length > 4) game.message.shift(); },
      printErr: () => {},
      onExit: (code) => { game.finish(code); },
    });
    return this._module;
  }

  finish(code) {
    if (this._over) return;
    this._over = true;
    if (this._gameOver) this._gameOver.resolve(code ?? 0);
  }

  async play() {
    const M = this._module;
    const setCallback = M.cwrap("shim_graphics_set_callback", null, ["string"]);
    const game = this;
    globalThis.nethackCallback = async (name, ...args) => game.callback(name, ...args);
    setCallback("nethackCallback");
    // Start the game. Asyncify: _main may return immediately (367) or a
    // promise (37); either way the game continues through the callback
    // and finishes via onExit / the "play again?" auto-answer.
    let mainRes;
    try {
      mainRes = M._main(0, 0);
    } catch (e) {
      if (!this._over) this.finish(0);
    }
    if (mainRes && typeof mainRes.then === "function") {
      mainRes.then(() => this.finish(0), () => this.finish(0));
    }
    const code = await new Promise((resolve) => { this._gameOver = { resolve }; });
    this._over = true;
    return code;
  }
}

// ─── Browser renderer: a full-screen TTY overlay ───────────────

export function createBrowserNethackCommand(hooks = {}) {
  const { write = () => {}, err = () => {}, onInterrupt = null } = hooks;
  // keyList: the shell's key-callback array. Pass the array directly, or
  // getKeyList() to resolve it lazily (the shell may declare it later).
  const keyList = () => (hooks.getKeyList ? hooks.getKeyList() : hooks.keyList);
  let root = null;
  let statusEl = null, mapEl = null, msgEl = null, menuEl = null;
  let keyHandler = null;
  let game = null;

  function keyCode(e) {
    const map = {
      ArrowUp: "k", ArrowDown: "j", ArrowLeft: "h", ArrowRight: "l",
      Enter: "\r", Escape: "\x1b", Backspace: "\x7f", Tab: "\t",
    };
    const k = map[e.key] || (e.key && e.key.length === 1 ? e.key : null);
    return k ? k.charCodeAt(0) : null;
  }

  function keyHook(key, event) {
    // called by the shell with (e.key, e); return true to claim the key
    const code = keyCode({ key });
    if (code !== null && game && game.feedKey(code)) return true;
    return false;
  }

  function buildDom() {
    root = document.createElement("div");
    root.id = "nethack-screen";
    root.style.cssText = [
      "position:fixed;inset:0;z-index:9000;background:#0b0b12;color:#d8d8d8;",
      "font-family:ui-monospace,Menlo,Consolas,'Courier New',monospace;",
      "display:flex;flex-direction:column;align-items:center;justify-content:center;",
    ].join("");
    const box = document.createElement("div");
    box.style.cssText = "width:min(96vw,86ch);";
    const head = document.createElement("div");
    head.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;font-size:12px;color:#7ec8e3;";
    const title = document.createElement("span");
    title.textContent = "NetHack 3.6.7 — real NetHack, compiled to WASM";
    const help = document.createElement("span");
    help.textContent = "hjklyubn move · . rest · q quit · i inventory · Ctrl+C shell";
    help.style.color = "#8b949e";
    head.append(title, help);

    statusEl = document.createElement("div");
    statusEl.style.cssText = "background:#101018;border:1px solid #2a2a3a;padding:4px 8px;white-space:nowrap;overflow:hidden;font-size:14px;";

    mapEl = document.createElement("div");
    mapEl.style.cssText = "background:#101018;border:1px solid #2a2a3a;margin-top:4px;padding:4px 8px;line-height:1.15;font-size:14px;white-space:pre;overflow:hidden;";

    menuEl = document.createElement("div");
    menuEl.style.cssText = "display:none;margin-top:4px;background:#181826;border:1px solid #3a3a55;padding:6px 10px;font-size:14px;white-space:pre;max-height:40vh;overflow:auto;";

    msgEl = document.createElement("div");
    msgEl.style.cssText = "background:#101018;border:1px solid #2a2a3a;margin-top:4px;padding:4px 8px;font-size:14px;min-height:3.4em;white-space:pre-wrap;";

    box.append(head, statusEl, mapEl, menuEl, msgEl);
    root.appendChild(box);
    document.body.appendChild(root);
  }

  function tearDown() {
    const list = keyList();
    if (keyHandler && Array.isArray(list)) {
      const i = list.indexOf(keyHandler);
      if (i !== -1) list.splice(i, 1);
    }
    keyHandler = null;
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
  }

  function renderScreen(g) {
    if (!root) return;
    statusEl.textContent = g.statusLine();
    if (g.mapDirty) {
      let html = "";
      for (let y = 0; y < MAP_H; y++) {
        const row = g.map[y] || [];
        let line = "";
        for (let x = 0; x < MAP_W; x++) {
          const c = row[x];
          line += c ? `<span style="color:${colorCss(c.color)}">${c.ch}</span>` : " ";
        }
        html += line + "\n";
      }
      mapEl.innerHTML = html;
      g.mapDirty = false;
    }
    msgEl.textContent = g.message.join("\n");
    if (g.menu.length) {
      menuEl.style.display = "block";
      menuEl.textContent = g.menu.map((m) => `${m.ch && m.ch !== " " ? m.ch : " "}  ${m.str}`).join("\n");
    } else {
      menuEl.style.display = "none";
    }
  }

  return async function nethack(args) {
    try {
      game = new NethackGame({ keys: null });
      await game.load();
      buildDom();
      game.onRender = renderScreen;
      const list = keyList();
      if (Array.isArray(list)) {
        keyHandler = keyHook;
        list.push(keyHandler);
      }
      if (onInterrupt) {
        onInterrupt(() => { game.finish(130); tearDown(); });
      }
      const code = await game.play();
      tearDown();
      write(`\nNetHack closed (exit ${code}).\n`);
      return code === 130 ? 130 : 0;
    } catch (e) {
      tearDown();
      err(`nethack: ${e.message}\n`);
      return 1;
    }
  };
}

// ─── CLI autoplay ─────────────────────────────────────────────

function demoKeys() {
  // Start a game (auto-pick answers the prompts), wander around, then
  // quit: M('q') = 241 (the tty meta-key for the quit command) — the
  // "Really quit?" and "play again?" prompts are auto-answered.
  const moves = "." + "hjkllhhk".repeat(8) + "jj." + "kllhk".repeat(4);
  const keys = [];
  for (const ch of moves) keys.push(ch.charCodeAt(0));
  keys.push(0x80 | "q".charCodeAt(0)); // M('q') = quit
  return keys;
}

export function createCliNethackCommand(out = process.stdout, err = process.stderr) {
  let snapshots = 0;
  return async function nethack(args) {
    if (args[0] !== "--demo") {
      out.write("nethack: the interactive game needs a browser — try 'nethack --demo' for a headless autoplay\n");
      return 0;
    }
    out.write("NetHack 3.6.7 (WASM) — headless autoplay demo…\n");
    const game = new NethackGame({ keys: demoKeys() });
    game.onRender = (g) => {
      // print a few snapshots to prove the game loop + rendering
      if (++snapshots % 60 !== 1) return;
      out.write("\n── NetHack demo snapshot (turn " + snapshots + ") ──\n");
      out.write(g.statusLine() + "\n");
      const crop = g.map.slice(0, 10).map((row) => (row || []).map((c) => c ? c.ch : " ").join("").slice(0, 60)).join("\n");
      out.write((crop || "(map not yet drawn)") + "\n");
      out.write("msg: " + g.message.join(" | ").slice(0, 110) + "\n");
    };
    try {
      await game.load();
      const code = await game.play();
      out.write(`\nNetHack demo finished (exit ${code}).\n`);
      return 0;
    } catch (e) {
      err(`nethack: ${e.message}\n`);
      return 1;
    }
  };
}
