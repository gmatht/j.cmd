---
name: todo
description: Task management for sh2runtime development. Add items, list them, mark done, and run them one by one automatically.
---

# TODO Skill

Manage development tasks for the sh2runtime browser shell project.

## Commands

All commands operate on `TODO.md` in the project root (`/root/src/sh2runtime/TODO.md`).

### List all items

```
## List all pending items, grouped by section
grep "^- \[" /root/src/sh2runtime/TODO.md
## Show counts
echo "Pending: $(grep -c '\- \[ \]' /root/src/sh2runtime/TODO.md)"
echo "Done: $(grep -c '\- \[x\]' /root/src/sh2runtime/TODO.md)"
```

### Add a new item

```
## Add to the appropriate section in TODO.md: - [ ] description
```

### Mark item done

```
## Replace [ ] with [x] for the matching item
sed -i 's/- \[ \] description/- [x] description/' /root/src/sh2runtime/TODO.md
```

## Auto-run: work through all items

The script `/root/src/sh2runtime/todo-runner.sh` drives pi through every
pending item, one at a time:

```bash
cd /root/src/sh2runtime
./todo-runner.sh              # run ALL pending items, one after another
./todo-runner.sh --limit 5    # run at most 5 items
./todo-runner.sh --dry-run    # preview items without running pi
```

For each item it:
1. Picks the next unchecked item (multi-line descriptions included)
2. Invokes `pi -p` (non-interactive) with the item text
3. After pi finishes, git-adds new source files (`.gitignore` filters
   build artifacts: `*.wasm`, `build/`, `node_modules/`, etc.)
4. Commits the item's changes
5. Marks the item `[x]` in TODO.md
6. Continues to the next item until none remain

## Project root

/root/src/sh2runtime/
