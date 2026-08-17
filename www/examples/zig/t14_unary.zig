// t14_unary: the A1 Un node — unary `!` on the C surface (PLAN_ZIG_F §3
// — primary() maps unary -/!/& onto the C surface 1:1; clib lowers the
// nil-RHS `!` shape to the arith Un AST). Zig requires `!` to take a
// bool, so the carrier is a bool var's `b = !b` assignment (a `!` in a
// print arg is valid C but invalid native Zig — a bool cannot format as
// {d}); if/while conditions lower to test calls, so the assignment is
// the Un carrier. `-x` on this surface lowers to Bin(0 - x) — the t02
// Bin shape, not Un.
const std = @import("std");

pub fn main() void {
    var b: bool = false;
    b = !b;
    if (b) {
        std.debug.print("truthy\n", .{});
    } else {
        std.debug.print("falsy\n", .{});
    }
    b = !b;
    if (b) {
        std.debug.print("truthy\n", .{});
    } else {
        std.debug.print("falsy\n", .{});
    }
}
