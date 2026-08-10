// ─── shellcore/resolve.js — the SHARED command resolution ─────
// One implementation of "what would the shell run for NAME?" — the
// walk both shells duplicated (findCommandExact / resolveCommandExact):
// explicit paths → wasm binaries in $PATH → builtins → sourced
// functions → .js/.mjs/.wasm files in $PATH, with case folding. The
// shell-specific tail (auto-loading wasm binaries from the server /
// staging lazy /bin templates) is a `ctx.autoLoad(name)` hook:
//
//   - CLI (node): read www/wasm-bin/*.wasm from disk + materialize
//     the lazy /bin templates (src/binsync.js)
//   - browser: fetch wasm-bin/*.wasm + writeBlob into the VFS +
//     materialize the lazy templates
import { fs } from "../fs/index.js";
import { env } from "../env.js";

// Unprivileged users (su nobody/daemon/guest/...) may only run
// admin-trusted code: builtins and .js/.wasm files owned by jtsh.
export function isPrivilegedUser() {
  const u = env.USER || "jtsh";
  return u === "jtsh" || u === "root";
}

// The unprivileged-user gate: custom (non-admin-owned) code is refused.
export function customExecDenied(path) {
  if (isPrivilegedUser()) return null;
  const a = fs.attrOf(path);
  const owner = a ? a.owner : "jtsh";
  if (owner === "jtsh") return null;
  return {
    type: "badpath",
    path,
    err: "operation not permitted: unprivileged users cannot run custom code (owned by " + owner + ")",
  };
}

// resolveCommand(ctx, name) — case folding + the walk (the browser
// also folded `vim` → `vi`; both fold a leading uppercase letter, so
// mobile keyboards' auto-capitalization still works).
export async function resolveCommand(ctx, name) {
  const found = await resolveCommandExact(ctx, name);
  if (found) return found;
  if (!name.includes("/") && /^[A-Z]/.test(name)) {
    return await resolveCommandExact(ctx, name[0].toLowerCase() + name.slice(1));
  }
  return null;
}

// resolveCommandExact(ctx, name) — the walk. `ctx.builtins` is the
// shell's merged builtins object, `ctx.otRt` the persistent transpiled
// runtime (sourced functions shadow commands), `ctx.autoLoad(name)`
// the shell-specific wasm staging + lazy-template materialization.
export async function resolveCommandExact(ctx, name) {
  // vim is an alias for vi
  if (name === "vim") name = "vi";

  // A name containing a "/" is an explicit path, like in /bin/sh: it is
  // resolved against the cwd and run directly (./a.wasm, /home/x.js,
  // ../run.mjs) instead of being looked up in $PATH. Bare names never
  // fall back to the cwd — that's what the leading ./ is for.
  if (name.includes("/")) {
    const resolved = fs._resolve(name);
    let st;
    try {
      st = await fs.stat(resolved);
    } catch {
      return null; // no such file
    }
    if (!st) return null;
    if (st.type === "dir") {
      return { type: "badpath", path: resolved, err: "Is a directory" };
    }
    if (/\.wasm$/i.test(resolved)) {
      const denied = customExecDenied(resolved);
      if (denied) return denied;
      return { type: "wasm", path: resolved };
    }
    if (/\.(js|mjs)$/i.test(resolved)) {
      const denied = customExecDenied(resolved);
      if (denied) return denied;
      return { type: "file", path: resolved };
    }
    // .sh files (and files with a #! shebang line) run through the bash
    // transpiler — the shell's native format for bash scripts.
    if (/\.sh$/i.test(resolved)) {
      const denied = customExecDenied(resolved);
      if (denied) return denied;
      return { type: "sh", path: resolved };
    }
    // A #! shebang makes any reasonably-sized TEXT file runnable. Skip
    // known binary extensions, and never read a huge file just to look
    // at its first line (fs.read supports { limit }).
    if (st &&
        !/\.(jpg|jpeg|png|gif|webp|bmp|ico|mp3|mp4|ogg|webm|wav|zip|gz|tgz|wasm|pdf|ttf|otf|woff2?|bin|exe|jar|class)$/i.test(resolved) &&
        (!st.size || st.size < 1024 * 1024)) {
      try {
        const head = String(await fs.read(resolved, { limit: 256 }));
        const m = /^#!\s*(\S+)/.exec(head.split("\n")[0] || "");
        if (m) {
          const denied = customExecDenied(resolved);
          if (denied) return denied;
          return { type: "sh", path: resolved, shebang: m[1] };
        }
      } catch {}
    }
    // The file exists but the shell can't run it (no interpreter here).
    return {
      type: "badpath",
      path: resolved,
      err: "cannot execute: only .js/.mjs/.wasm files are runnable",
    };
  }

  // A wasm32-wasi binary in the command path is a "native command" and
  // shadows the builtin of the same name — so `wasmer install grep`
  // (which drops /bin/grep.wasm) makes `grep` run real grep compiled
  // to WASM instead of the JS fallback.
  const searchPaths = env.PATH.split(":").filter(Boolean);
  for (const dir of searchPaths) {
    try {
      const entries = await fs.list(dir);
      if (entries.includes(name + ".wasm")) {
        const p = dir + "/" + name + ".wasm";
        const denied = customExecDenied(p);
        if (denied) return denied;
        return { type: "wasm", path: p };
      }
    } catch {}
  }

  if (ctx.builtins && ctx.builtins[name]) return { type: "builtin", fn: ctx.builtins[name] };

  // A function defined by a sourced file / transpiled line (the
  // persistent otRt's sh2.functions map — bash's function table) shadows
  // commands, like in bash: `source fn.c` defining `testc()` then a bare
  // `testc` runs the body with the args as $1..$N.
  if (ctx.otRt && ctx.otRt.sh2 && ctx.otRt.sh2.functions && ctx.otRt.sh2.functions.has(name)) {
    return {
      type: "builtin",
      fn: async (args) => {
        const v = await ctx.otRt.sh2.fnCall(name, args);
        // the function may have mutated the runtime store (an in-place
        // sort/fill) — harvest it back so the next transpiled line's
        // seed sees the LIVE values, not a stale otVars snapshot.
        if (ctx.syncOtVarsFromStore) ctx.syncOtVarsFromStore();
        return (v === false ? 1 : (v === true || v === undefined ? 0 : Number(v) || 0));
      },
    };
  }

  // Walk the command path from $PATH (colon-separated, like POSIX)
  for (const dir of searchPaths) {
    try {
      for (const entry of await fs.list(dir)) {
        const clean = entry.replace(/\/$/, "");
        if (clean === name || clean === name + ".js") {
          const p = dir + "/" + clean;
          const denied = customExecDenied(p);
          if (denied) return denied;
          return { type: "file", path: p };
        }
        if (clean === name + ".mjs") {
          const p = dir + "/" + clean;
          const denied = customExecDenied(p);
          if (denied) return denied;
          return { type: "file", path: p };
        }
        if (clean === name + ".wasm") {
          const p = dir + "/" + clean;
          const denied = customExecDenied(p);
          if (denied) return denied;
          return { type: "wasm", path: p };
        }
      }
    } catch {}
  }

  // Shell-specific tail: auto-load a wasm binary / lazy command
  // template (the browser fetches wasm-bin/, the CLI reads it from
  // disk; both materialize the /bin templates via binsync).
  if (ctx.autoLoad) return await ctx.autoLoad(name);
  return null;
}
