// t13_const_cast: @intCast / @as — the identity cast `(int) x` onto
// clib's C surface (PLAN_ZIG_F §3). @intCast needs a known result type
// (std.debug.print args are anytype), so the cast is pinned in a typed
// declaration; @as pins the in-expression form.
const std = @import("std");

pub fn main() void {
    const x: i32 = 7;
    const y: i32 = @intCast(x);
    std.debug.print("{d}\n", .{y});
    std.debug.print("{d}\n", .{@as(i32, 5) + y});
    std.debug.print("{d}\n", .{@as(i32, 300)});
}
