# debashcl integration — bash support via the sh2 toolchain

jtsh now runs bash through the **debashcl ESTree path** (from
`root@10.42.0.1:/nvme/ai`, vendored under `vendor/sh2/` and
`www/wasm-bin/`):

```
bash source
   │  debashcl.wasm (unified CLI reactor: debashc_cli_run*)
   ▼
ESTree JSON (standard node types, shell semantics lowered to sh2.* calls)
   │  src/estree.js (small emitter, 19 node types)
   ▼
JavaScript source  ──run with the sh2.* runtime (src/sh2runtime.js)──▶
   │                    output via the shell's own command machinery
   ▼
terminal
```

The old path (`sh2perl.wasm → Perl → perl2js`) and the redundant
sh2perl.wasm command binary were removed — debashcl.wasm is the one
compiler, wrapped by the `/bin/sh2js.js`, `/bin/sh2perl.js` and
`/bin/debashc.js` commands (all driving the same reactor via
`src/sh2lib.js`).

## Verified working (CLI + browser, Playwright-tested)

- commands, args, quoting, `$VAR`/`${VAR}` expansion
- `for`/`while` loops, `if`/`elif`/`else`, `&&`/`||`, `case` (glob patterns)
- arithmetic `$((...))` (incl. variables), `$((x+1))` in loop counters
- pipelines (`|`), stdin chaining, exit status (`$?`)
- command substitution `$(...)` (nested), word-splitting via captureWords
- redirection `>` `>>` `2>` (fd 1/2, truncate/append)
- file tests `[ -f x ]`/`[ -d x ]` (via new `statSync` on local mounts),
  string/numeric tests, `!`, `-a`/`-o`, `( )`
- functions (`f() { ... }`, args → `$1..$9`, `$@`, `$#`)
- brace expansion `{1..3}` `{a..c}`, param expansion `${x:-d}` `${x:=d}`
  `${x#p}` `${x%%p}` `${#x}` `${x:1:3}`, positional params (`bash '...' a b`)
- `bash2js` / `sh2js` / `sh2perl` / `debashc` commands (ESTree / JS / Perl)

## Findings for the debashc side (fix upstream)

1. **`test` is emitted without `await`, even for file tests** —
   `[ -f x ] && cmd` becomes `sh2.test("-f x") && await sh2.exec(...)`.
   That forces the runtime's `sh2.test` to be *synchronous*; a runtime
   backed by async-only fs can't comply. Either await the test call, or
   spec `sh2.test` as sync (the sh2runtime reference implements it with
   `statSync`). Same for `if (sh2.test(...))` and `while` conditions.

2. **Multiple brace groups are not cross-producted** —
   `x{1..2}{a,b}` emits two independent `sh2.brace(...)` calls plus the
   literal `"a" "b"` words (result `x1 x2 a b`), where bash yields
   `x1a x1b x2a x2b`. The `brace` contract can't express the cross
   product from the args as emitted.

3. **Brace `post` suffix escapes the word** —
   `echo pre-{1..3}-post` yields `pre-1 pre-2 pre-3 -post` (`-post`
   becomes its own word). Looks like the trailing literal is emitted as
   a separate array element rather than the `post` argument.

4. **`${s#h}` and `${#s}` use two different encodings** —
   prefix-removal is `param("#", "s", "h")` while length is
   `getVar("#s")`. Confusing but distinguishable; document it.

5. **`case` labels are pattern strings, `caseMatch` must return the
   matched pattern** (not an index) for the emitted
   `switch (sh2.caseMatch(...)) { case "a": ... }` to line up.
   With a literal discriminant debashcl emits a TemplateLiteral
   (`` caseMatch(`b`, [...]) ``) which is fine.

6. **`${x:1:3}` slices** come through as `param("slice", x, 1, 3)` —
   an ad-hoc op name; fine, but worth documenting alongside the
   `-`/`:-`/`+`/`:+`/`=`/`:=`/`?`/`:?` set.

## Notes

- `bash 'inline source' arg1 arg2` treats extra args as positional
  params (`$1..`), matching `bash -c 'src' a b`.
- `sh2.test` file tests are sync and cover **local mounts only**
  (`statSync`; remote paths report false).
- Arithmetic evaluation uses `new Function` on a sanitized
  `[0-9+\-*/%().]` expression after variable substitution.
- The generated JS is standard — save `bash2js` output to `/bin/foo.js`
  and it runs as a command (the shell injects `sh2` into command scope).
