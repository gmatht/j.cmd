@echo off
rem v1.2: && and || conjunctions (the A1 BinOp And/Or shape —
rem byte-identical to the core's `a && b` / `a || b` lowering).
rem posix tools: nosuchcmd is a deliberately-failing command
echo one && echo two
nosuchcmd || echo caught
echo four || echo five
echo a&echo b && echo c
echo done
