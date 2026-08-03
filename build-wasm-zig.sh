#!/bin/bash
# ─── build-wasm-zig.sh ─────────────────────────────────────────
# Build a wasm32-wasi Zig compiler for the browser shell.
#
# The shell runs wasm32-wasi binaries as native commands (src/wasm.js).
# A wasm build of the Zig compiler lets you write Zig inside tinysh:
#
#   zig version
#   zig build-exe hello.zig -target wasm32-wasi
#
# Pipeline (the canonical bootstrap — https://github.com/ziglang/zig-bootstrap):
#   1. zig-bootstrap builds a native toolchain from source (LLVM/Clang/LLD
#      + zig, pinned versions; no system zig needed).
#   2. The bootstrapped zig cross-compiles the compiler for wasm32-wasi
#      with the self-hosted codegen (-Denable-llvm=false — LLVM does not fit
#      in wasm; the wasm compiler emits wasm32 with its own backend and has
#      no C frontend).
#   3. A set of small source patches (see below) makes the full compiler
#      compile for wasm (the CI zig1.wasm build uses dev=bootstrap, which
#      lacks the wasm linker — we want the full compiler).
#   4. The result lands in www/wasm-bin/zig.wasm.
#
# Runtime requirements in the shell:
#   - ZIG_LIB_DIR must point at a zig lib (std + compiler_rt; the installed
#     zig-out/lib/zig tree). Stage it into a seeded dir, e.g. /tmp/zig-lib.
#   - ZIG_LOCAL_CACHE_DIR / ZIG_GLOBAL_CACHE_DIR point at a writable dir.
#   - WASM_SKIP_HARVEST=<lib dir> tells the runner not to harvest the
#     read-only lib back (it is seeded but never modified).
#
# KNOWN LIMITATION: the shell's wasmer-wasi runtime mangles data written via
# fd_pwrite (a wasmer-wasi bug — the only wasm command using pwrite today is
# zig). `zig version`/`zig help` work; `zig build-exe` runs but the emitted
# binary is corrupted by the runtime's write path. Under a V8-based WASI
# (node:wasi, wasmtime) the same compiler produces correct binaries
# (verified: version, build-exe, and the compiled program runs). Fixing the
# shell integration needs the fd_pwrite issue addressed in wasmer-wasi.
#
# Source patches (applied by this script):
#   Compilation.zig  Directories.init params: wasi_preopens/self_exe_path are
#                    no longer target-switched (callers use native_os).
#   main.zig         self_exe_path is null on a wasm target; wasi_preopens is
#                    passed unconditionally; Child.spawn guarded by
#                    process.can_spawn.
#   introspect.zig   resolveGlobalCacheDir returns "/.zig-cache" on wasi.
#   MappedFile.zig   wasi fallback (heap buffer, compile-only — unused by the
#                    wasm linker).
#   print_env.zig    cmdEnv passes preopens/self-exe unconditionally.
#   Compilation.zig  isNested treats a "/" module root as the root dir.
#   Wasm/Flush.zig   no entry-based start section (WASI runtimes run start
#                    sections during instantiation, before _start).
#
# Usage:
#   ./build-wasm-zig.sh                # full build (~1-2h on 16 cores)
#   ZB_DIR=/existing/zig-bootstrap ./build-wasm-zig.sh   # skip step 1
# -----------------------------------------------------------------

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
WORK="${ZB_DIR:-$REPO/.zig-bootstrap}"
TRIPLE=x86_64-linux-gnu

# The bootstrap's cmake build produces the working self-hosted zig here
# (stage1/2 chain); the script also builds a final stage3 elsewhere, but
# this one is what we cross-compile with.
if [ ! -x "$WORK/out/build-zig-host/stage3/bin/zig" ]; then
  echo "==> bootstrapping native zig ($TRIPLE) with zig-bootstrap"
  rm -rf "$WORK"
  git clone --depth 1 https://github.com/ziglang/zig-bootstrap "$WORK"
  (cd "$WORK" && ./build "$TRIPLE" native)
fi
ZIG="$WORK/out/build-zig-host/stage3/bin/zig"
"$ZIG" version

echo "==> applying wasm-target patches to the zig source"
cd "$WORK/zig"
apply_patch() {  # $1 = file, $2 = old, $3 = new
  python3 - "$1" "$2" "$3" <<'PYEOF'
import sys
p, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p).read()
assert old in s, f"patch target not found in {p}"
open(p, 'w').write(s.replace(old, new))
PYEOF
}
cd "$REPO"  # patches are written inline below against $WORK/zig

python3 - "$WORK/zig/src/Compilation.zig" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p).read()
s = s.replace('''        wasi_preopens: switch (builtin.target.os.tag) {
            .wasi => fs.wasi.Preopens,
            else => void,
        },
        self_exe_path: switch (builtin.target.os.tag) {
            .wasi => void,
            else => []const u8,
        },''',
'''        wasi_preopens: fs.wasi.Preopens,
        self_exe_path: ?[]const u8,''')
s = s.replace('break :d introspect.findZigLibDirFromSelfExe(arena, cwd, self_exe_path) catch |err| {',
              'break :d introspect.findZigLibDirFromSelfExe(arena, cwd, self_exe_path orelse unreachable) catch |err| {')
s = s.replace('''        if (inner.root != outer.root) return .different_roots;
        if (!mem.startsWith(u8, inner.sub_path, outer.sub_path)) return .no;
        if (inner.sub_path.len == outer.sub_path.len) return .no;
        if (outer.sub_path.len == 0) return .{ .yes = inner.sub_path };
        if (inner.sub_path[outer.sub_path.len] != fs.path.sep) return .no;
        return .{ .yes = inner.sub_path[outer.sub_path.len + 1 ..] };''',
'''        if (inner.root != outer.root) return .different_roots;
        if (!mem.startsWith(u8, inner.sub_path, outer.sub_path)) return .no;
        if (inner.sub_path.len == outer.sub_path.len) return .no;
        if (outer.sub_path.len == 0 or mem.eql(u8, outer.sub_path, "/")) return .{ .yes = inner.sub_path };
        if (inner.sub_path[outer.sub_path.len] != fs.path.sep) return .no;
        return .{ .yes = inner.sub_path[outer.sub_path.len + 1 ..] };''')
open(p, 'w').write(s)
PYEOF

python3 - "$WORK/zig/src/main.zig" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p).read()
s = s.replace('''    const self_exe_path = switch (native_os) {
        .wasi => {},
        else => fs.selfExePathAlloc(arena) catch |err| {
            fatal("unable to find zig self exe path: {s}", .{@errorName(err)});
        },
    };''',
'''    const self_exe_path = switch (native_os) {
        .wasi => @as(?[]const u8, null),
        else => if (builtin.target.os.tag == .wasi)
            @as(?[]const u8, null)
        else
            fs.selfExePathAlloc(arena) catch |err| {
                fatal("unable to find zig self exe path: {s}", .{@errorName(err)});
            },
    };''')
s = s.replace('''    const self_exe_path = try fs.selfExePathAlloc(arena);
    try child_argv.append(self_exe_path);''',
'''    const self_exe_path = if (builtin.target.os.tag == .wasi)
        @as(?[]const u8, null)
    else
        try fs.selfExePathAlloc(arena);
    if (self_exe_path) |sep| try child_argv.append(sep);''')
s = s.replace('''    const self_exe_path = fs.selfExePathAlloc(arena) catch |err| {
        fatal("unable to find self exe path: {s}", .{@errorName(err)});
    };''',
'''    const self_exe_path = if (builtin.target.os.tag == .wasi)
        @as(?[]const u8, null)
    else
        fs.selfExePathAlloc(arena) catch |err| {
            fatal("unable to find self exe path: {s}", .{@errorName(err)});
        };''')
# wasi_preopens call sites
s = s.replace('''            if (native_os == .wasi) wasi_preopens,
            &host,''',
'''            wasi_preopens,
            &host,''')
s = s.replace('''        {},
        self_exe_path,
    );''',
'''        wasi_preopens,
        self_exe_path,
    );''')
s = s.replace('''            if (native_os == .wasi) wasi_preopens,
        self_exe_path,''',
'''            wasi_preopens,
        self_exe_path,''')
s = s.replace('''        .global,
        if (native_os == .wasi) wasi_preopens,
        self_exe_path,
    );
    defer dirs.deinit();

    var thread_pool: ThreadPool = undefined;''',
'''        .global,
        wasi_preopens,
        self_exe_path,
    );
    defer dirs.deinit();

    var thread_pool: ThreadPool = undefined;''')
s = s.replace('''    if (options.prepend_zig_exe_path)
        child_argv.appendAssumeCapacity(self_exe_path);''',
'''    if (options.prepend_zig_exe_path)
        if (self_exe_path) |sep| child_argv.appendAssumeCapacity(sep);''')
s = s.replace('''    var zig_lib_directory = introspect.findZigLibDirFromSelfExe(arena, cwd_path, self_exe_path) catch |err| {''',
'''    var zig_lib_directory = introspect.findZigLibDirFromSelfExe(arena, cwd_path, self_exe_path orelse "") catch |err| {''')
s = s.replace('''        fatal("unable to find zig installation directory '{s}': {s}", .{ self_exe_path, @errorName(err) });''',
'''        fatal("unable to find zig installation directory '{s}': {s}", .{ self_exe_path orelse "", @errorName(err) });''')
s = s.replace('''            test_exec_args.items,
            self_exe_path,
            arg_mode,''',
'''            test_exec_args.items,
            self_exe_path orelse "",
            arg_mode,''')
# spawn guards
s = s.replace('''    if (!process.can_spawn) {
        const cmd = try std.mem.join(arena, " ", child_argv.items);
        fatal("the following command cannot be executed ({s} does not support spawning a child process):\\n{s}", .{
            @tagName(native_os), cmd,
        });
    }

    var child = std.process.Child.init(child_argv.items, gpa);''',
'''    if (!process.can_spawn) {
        const cmd = try std.mem.join(arena, " ", child_argv.items);
        fatal("the following command cannot be executed ({s} does not support spawning a child process):\\n{s}", .{
            @tagName(native_os), cmd,
        });
    }

    if (comptime process.can_spawn) {
    var child = std.process.Child.init(child_argv.items, gpa);''')
s = s.replace('''    const term = try child.wait();
    switch (term) {
        .Exited => |code| {
            if (code == 0) {
                if (options.capture != null) return;
                return cleanExit();
            }
            const cmd = try std.mem.join(arena, " ", child_argv.items);
            fatal("the following build command failed with exit code {d}:\\n{s}", .{ code, cmd });
        },
        else => {
            const cmd = try std.mem.join(arena, " ", child_argv.items);
            fatal("the following build command crashed:\\n{s}", .{cmd});
        },
    }''',
'''    const term = try child.wait();
    switch (term) {
        .Exited => |code| {
            if (code == 0) {
                if (options.capture != null) return;
                return cleanExit();
            }
            const cmd = try std.mem.join(arena, " ", child_argv.items);
            fatal("the following build command failed with exit code {d}:\\n{s}", .{ code, cmd });
        },
        else => {
            const cmd = try std.mem.join(arena, " ", child_argv.items);
            fatal("the following build command crashed:\\n{s}", .{cmd});
        },
    }
    } else {
        return;
    }''')
s = s.replace('''        else => {
            var child = std.process.Child.init(argv.items, gpa);

            child.stdin_behavior = .Inherit;
            child.stdout_behavior = .Inherit;
            child.stderr_behavior = .Inherit;

            try child.spawn();

            return child.id;
        },
    }
}''',
'''        else => if (comptime process.can_spawn) {
            var child = std.process.Child.init(argv.items, gpa);

            child.stdin_behavior = .Inherit;
            child.stdout_behavior = .Inherit;
            child.stderr_behavior = .Inherit;

            try child.spawn();

            return child.id;
        } else {
            return error.ProcessNotSupported;
        },
    }
}''')
open(p, 'w').write(s)
PYEOF

python3 - "$WORK/zig/src/introspect.zig" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p).read()
s = s.replace('''    if (builtin.os.tag == .wasi)
        @compileError("on WASI the global cache dir must be resolved with preopens");

    if (try std.zig.EnvVar.ZIG_GLOBAL_CACHE_DIR.get(allocator)) |value| return value;''',
'''    if (builtin.os.tag == .wasi) {
        if (try std.zig.EnvVar.ZIG_GLOBAL_CACHE_DIR.get(allocator)) |value| return value;
        return allocator.dupe(u8, "/.zig-cache");
    }

    if (try std.zig.EnvVar.ZIG_GLOBAL_CACHE_DIR.get(allocator)) |value| return value;''')
s = s.replace('''    const self_exe_path = try fs.selfExePathAlloc(gpa);
    defer gpa.free(self_exe_path);

    return findZigLibDirFromSelfExe(gpa, cwd_path, self_exe_path);''',
'''    const self_exe_path = if (builtin.os.tag == .wasi)
        @as(?[]const u8, null)
    else
        try fs.selfExePathAlloc(gpa);
    defer if (self_exe_path) |sep| gpa.free(sep);

    return findZigLibDirFromSelfExe(gpa, cwd_path, self_exe_path orelse "");''')
open(p, 'w').write(s)
PYEOF

python3 - "$WORK/zig/src/link/MappedFile.zig" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p).read()
s = s.replace('''    } else mf.contents = try std.posix.mmap(
        null,
        aligned_capacity,
        std.posix.PROT.READ | std.posix.PROT.WRITE,
        .{ .TYPE = if (is_linux) .SHARED_VALIDATE else .SHARED },
        mf.file.handle,
        0,
    );
}''',
'''    } else if (is_wasi) {
        // wasm has no mmap (MappedFile is only used by the ELF/Mach-O/COFF
        // linkers — never by the wasm linker — so this fallback exists only
        // to keep the module compiling for wasm32-wasi builds of zig).
        mf.contents = try std.heap.c_allocator.alignedAlloc(u8, std.mem.Alignment.fromByteUnits(std.heap.page_size_min), aligned_capacity);
    } else mf.contents = try std.posix.mmap(
        null,
        aligned_capacity,
        std.posix.PROT.READ | std.posix.PROT.WRITE,
        .{ .TYPE = if (is_linux) .SHARED_VALIDATE else .SHARED },
        mf.file.handle,
        0,
    );
}''')
s = s.replace('''const is_linux = builtin.os.tag == .linux;
const is_windows = builtin.os.tag == .windows;''',
'''const is_linux = builtin.os.tag == .linux;
const is_windows = builtin.os.tag == .windows;
const is_wasi = builtin.os.tag == .wasi;''')
open(p, 'w').write(s)
PYEOF

python3 - "$WORK/zig/src/print_env.zig" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p).read()
s = s.replace('''    wasi_preopens: switch (builtin.target.os.tag) {
        .wasi => std.fs.wasi.Preopens,
        else => void,
    },''',
'''    wasi_preopens: std.fs.wasi.Preopens,''')
s = s.replace('''        .global,
        if (builtin.target.os.tag == .wasi) wasi_preopens,
        if (builtin.target.os.tag != .wasi) self_exe_path,
    );''',
'''        .global,
        wasi_preopens,
        self_exe_path,
    );''')
open(p, 'w').write(s)
PYEOF

python3 - "$WORK/zig/src/link/Wasm/Flush.zig" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p).read()
s = s.replace('''    // start section
    if (wasm.functions.getIndex(.__wasm_init_memory)) |func_index| {
        try emitStartSection(gpa, binary_bytes, .fromFunctionIndex(wasm, @enumFromInt(func_index)));
    } else if (Wasm.OutputFunctionIndex.fromResolution(wasm, wasm.entry_resolution)) |func_index| {
        try emitStartSection(gpa, binary_bytes, func_index);
    }''',
'''    // start section. Only __wasm_init_memory (passive-segment copying) is
    // emitted here — the entry function must NOT be a start section: WASI
    // runtimes (Node, Wasmer) run start sections during instantiation,
    // before _start is invoked, so an entry-based start traps there.
    // The _start export is the entry point, per the WASI convention.
    if (wasm.functions.getIndex(.__wasm_init_memory)) |func_index| {
        try emitStartSection(gpa, binary_bytes, .fromFunctionIndex(wasm, @enumFromInt(func_index)));
    }''')
open(p, 'w').write(s)
PYEOF

echo "==> cross-compiling the compiler for wasm32-wasi (self-hosted codegen)"
(cd "$WORK/zig" && "$ZIG" build \
  -Dtarget=wasm32-wasi \
  -Doptimize=ReleaseSmall \
  -Denable-llvm=false \
  -Dstatic-llvm=false \
  -Dforce-link-libc=true)

WASM="$WORK/zig/zig-out/bin/zig.wasm"
ls -lh "$WASM"
cp "$WASM" "$REPO/www/wasm-bin/zig.wasm"
echo "==> installed www/wasm-bin/zig.wasm"
echo "    quick check: wasmer install zig && zig version"
