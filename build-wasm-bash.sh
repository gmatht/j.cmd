#!/bin/sh
# ─── build-wasm-bash.sh: build the real bash 5.3 wasm (asyncify spawn) ───
#
# Produces www/vendor/bash.js + www/wasm-bin/bash.wasm — the REAL bash
# binary with the web-spawn bridge:
#
#   BASH_WEB_SPAWN  — execute_cmd.c runs top-level external commands
#                     through the EM_JS hook bash_web_spawn() instead of
#                     forking (bash.wasm can't fork). The hook suspends
#                     via Asyncify; the host shell runs the command and
#                     returns its exit status — so output order, $? and
#                     stdin redirects / here-strings all work.
#
# Prereqs: emsdk active (emcc 6.0.6 tested), bash source at
#          bash-wasm/bash-5.3 (patched execute_cmd.c — the patch lives at
#          patches/bash-web-spawn.patch and is applied on top of the
#          vendored emscripten-bash-wasm repo), configured build tree at
#          bash-wasm/build (emconfigure).
#
# Usage:  . /root/src/emsdk/emsdk_env.sh   (if not already active)
#         ./build-wasm-bash.sh
set -e
cd "$(dirname "$0")/bash-wasm/build"
# syscall-shim.o — override the libc calls bash makes whose raw syscalls
# the emscripten runtime doesn't implement (getresgid/getrusage/wait4/
# prlimit64), so bash.wasm never prints "warning: unsupported syscall".
# Linked ahead of libc (the make LDFLAGS overrides the Makefile's
# ADDON_LDFLAGS composition, so the shim goes straight into LDFLAGS)
# so the shim wins over musl.
emcc -c ../bash-5.3/syscall-shim.c -o syscall-shim.o
emmake make \
  CFLAGS='-g -O2 -DBASH_WEB_SPAWN' \
  LDFLAGS='syscall-shim.o -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS,callMain -sMODULARIZE=1 -sEXPORT_NAME=createBashModule -sASYNCIFY=1 -sASYNCIFY_IMPORTS=bash_web_spawn,bash_web_spawn_capture -sASYNCIFY_STACK_SIZE=262144 -sEXPORT_ES6=1'
cp bash.wasm ../../www/wasm-bin/bash.wasm
cp bash ../../www/vendor/bash.js
echo "installed www/vendor/bash.js + www/wasm-bin/bash.wasm"
