// t10_defer: function-scope `defer` runs in REVERSE at scope exit — the
// desugar appends the deferred statements, reversed, before every return
// and at the function end (PLAN_ZIG_F §3).
const std = @import("std");

fn f() i32 {
    defer std.debug.print("deferred\n", .{});
    return 1;
}

pub fn main() void {
    std.debug.print("before\n", .{});
    defer std.debug.print("first\n", .{});
    defer std.debug.print("second\n", .{});
    std.debug.print("{d}\n", .{f()});
    std.debug.print("after\n", .{});
}
