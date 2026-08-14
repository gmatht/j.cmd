// t01_print: the worker's first work item (the gate is RED until this
// lands). Zig's std.debug.print writes to STDERR — the frontend-stdout
// `zig` case captures the native side with 2>&1 (the transpiled target
// emits stdout; the observable output is the comparison).
const std = @import("std");

pub fn main() void {
    std.debug.print("hello zig\n", .{});
}
