---
name: use-locate
description: Find files fast. Never run a whole-filesystem 'find /' or 'grep -r /' — use locate, targeted finds with -maxdepth, or known paths. Load for ANY filesystem search: finding files, modules, binaries, interfaces, wasm binaries, or unknown paths.
---

# Use Locate, Not `find /`

A whole-filesystem `find /` is extremely slow (minutes to hours — it scans
`/proc`, `/sys`, snap mounts, node_modules, etc.). Prefer fast alternatives
in this order:

## 1. `locate` (if available)

```bash
locate interface.js        # instant, database-backed
locate <name> | head -20
```

## 2. Targeted `find` with `-maxdepth`

Never search from `/` or `~`. Start from a specific directory and limit depth:

```bash
find /usr/local/lib/node_modules -maxdepth 4 -name "interface.js" 2>/dev/null
find /root/src -maxdepth 6 -name "*.js" 2>/dev/null | head -20
```

## 3. Known paths (fastest — no search at all)

Check well-known locations directly instead of searching:

```bash
node -p "require.resolve('readline/interface.js')" 2>/dev/null
node -p "process.execPath"                       # Node's own binary path
npm root -g                                      # global node_modules
ls /usr/lib/node_modules 2>/dev/null
ls /usr/local/lib/node_modules 2>/dev/null
echo $NODE_PATH
which <tool>
```

For Node.js core modules like `readline`, they live inside the Node
installation — `process.execPath` + `../lib/node_modules/...` or
`node -p "require.resolve('readline')"` finds them instantly.

## 4. Avoid these entirely

- `find / ...` (whole filesystem)
- `grep -r ... /` (whole filesystem)
- `find / -name "*.js"` without a bounded start path
- Recursing into `node_modules` unless explicitly needed

## When you genuinely need the whole tree

`find /` is only justified for a specific, bounded goal (e.g. checking a
file exists exactly once). Even then, bound it:

```bash
find / -xdev -name "target" -maxdepth 10 2>/dev/null | head -5
```

`-xdev` stays on one filesystem, `-maxdepth` bounds the depth, `head`
stops early, and `2>/dev/null` hides permission noise.

## Rule of thumb

If a search takes more than a few seconds, you're doing it wrong. Stop,
pick a more specific start path or a known location, and retry.
