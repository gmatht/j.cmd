// t02_arith: the A1 Arith node — binary arithmetic in print arguments
// (PLAN_ZIG_F §6). expr()/primary() map Zig operators 1:1 onto the C
// surface, and clib lowers the printf args to the Arith Bin AST.
const std = @import("std");

pub fn main() void {
    std.debug.print("{d}\n", .{1 + 2});
    std.debug.print("{d}\n", .{3 * 4});
    std.debug.print("{d}\n", .{(8 - 3) * 2});
}
