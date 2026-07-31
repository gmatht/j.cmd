---
name: todo
description: Task management for sh2runtime development. Add items, list them, mark done, work through them one by one.
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
## Add to the "Short-term" section (or specify which section)
## Edit TODO.md and add: - [ ] description
```

### Mark item done

```
## Replace [ ] with [x] for the matching item
sed -i 's/- \[ \] description/- [x] description/' /root/src/sh2runtime/TODO.md
```

### Show next item

```
## Show the first unchecked item
grep -A0 '\- \[ \]' /root/src/sh2runtime/TODO.md | head -3
```

## Workflow

1. User says "add: implement X"
2. Skill adds `- [ ] implement X` to the appropriate section in TODO.md
3. User says "do the next thing" or "work through the list"
4. Skill picks the first `[ ]` item, reads context, implements it
5. On completion, marks as `[x]` and commits
6. Repeats until all items are done or user stops

## Project root

/root/src/sh2runtime/
