// t17_binary: the rest of the A1 Bin surface — == != <= (if-condition
// carriers; t03 pinned >= > <) and / % (print-arg int arithmetic; t02
// pinned + - *). expr() maps the Zig operators 1:1 onto the C surface
// (PLAN_ZIG_F §3), and clib lowers both the test and arith shapes; the
// native oracle agrees because Zig and C compute the same integers.
const std = @import("std");

pub fn main() void {
    const x = 7;
    const y = 3;
    if (x == y) {
        std.debug.print("eq\n", .{});
    } else if (x != y) {
        std.debug.print("neq\n", .{});
    }
    if (x <= y) {
        std.debug.print("le\n", .{});
    } else {
        std.debug.print("gt\n", .{});
    }
    std.debug.print("{d}\n", .{x / y});
    std.debug.print("{d}\n", .{x % y});
}
