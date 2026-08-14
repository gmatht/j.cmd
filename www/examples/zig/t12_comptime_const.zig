// t12_comptime_const: comptime `const` values at container scope — the
// desugar emits plain int declarations and clib's const folding collapses
// the chain (the c-sh-go t82_const family).
const std = @import("std");

const N = 5;
const M = N * 2;

pub fn main() void {
    std.debug.print("{d}\n", .{M});
    std.debug.print("{d}\n", .{N + M});
}
