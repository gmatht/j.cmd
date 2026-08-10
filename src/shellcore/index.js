// ─── shellcore/index.js — the SHARED shell core ────────────────
// One implementation of the command layer both shells (the node CLI
// src/jtsh.js and the browser shell www/index.html) consume. The
// builtins are parameterized by a `ctx` — the shell-specific I/O and
// machinery the adapter provides:
//
//   ctx.stdout / ctx.stderr     writable sinks ({ write(s) })
//   ctx.stdin                   the current pipe input ("" if none)
//   ctx.isTTY                   is the terminal interactive?
//   ctx.runNestedCommand        run a command line in the same shell
//                               (pipelines/redirects/command-subst)
//   ctx.findCommand             resolve a command name (wasm→builtin→…)
//   ctx.ensureOtRuntime         lazy-persistent transpiled runtime
//   ctx.otRt                    the persistent runtime (getter — live)
//   ctx.runSourceContent        source a file's content into the shell
//   ctx.wasmRunner / ctx.goCmd  wasm execution instances
//   ctx.isPrivilegedUser        security gate for custom code
//   ctx.getBgJobs               the background-jobs controller
//   ctx.enterRepl(mode)         enter the interactive REPL ("bash"|"cmd")
//   ctx.exit()                  leave the shell (CLI: process.exit;
//                               browser: the GUI goodbye)
//   ctx.nodeEnv / ctx.nodeCwd   node-only env/cwd (undefined in browser)
//
// The shared singletons (fs, env, manpages, shell state) are imported
// by the builtins directly — both adapters use the same src/ modules.
import { builtins } from "./builtins.js";
import { InterruptError } from "./runner.js";

// Bind the shared builtins to an adapter's ctx: `async NAME(args)` —
// the signature both shells' command dispatchers already call.
export function createShellCore(ctx) {
  const bound = {};
  for (const [name, fn] of Object.entries(builtins)) {
    bound[name] = (args) => fn(ctx, args);
  }
  return { builtins: bound, InterruptError };
}

export { InterruptError };
