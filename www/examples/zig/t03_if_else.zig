// t03_if_else: if / else-if / else chain (PLAN_ZIG_F §3 — the Zig
// C-compatible control flow maps 1:1 onto clib's if lowering, the shape
// c-sh-go pins as t04_if_else/t34_elseif).
const std = @import("std");

pub fn main() void {
    const s = 85;
    if (s >= 90) {
        std.debug.print("A\n", .{});
    } else if (s >= 80) {
        std.debug.print("B\n", .{});
    } else if (s >= 70) {
        std.debug.print("C\n", .{});
    } else {
        std.debug.print("F\n", .{});
    }
    if (s > 0) {
        std.debug.print("pos\n", .{});
    } else {
        std.debug.print("neg\n", .{});
    }
}
