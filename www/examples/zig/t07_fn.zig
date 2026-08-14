// t07_fn: user functions (multi-param, nested calls) — `fn` desugars to
// `static int` (the c-sh-go t17_func_call/t55_multi_fn shape).
const std = @import("std");

fn triple(n: i32) i32 {
    return n * 3;
}

fn add(a: i32, b: i32) i32 {
    return a + b;
}

pub fn main() void {
    std.debug.print("{d}\n", .{triple(5)});
    std.debug.print("{d}\n", .{add(triple(1), 2)});
    std.debug.print("{d}\n", .{triple(add(2, 3))});
}
