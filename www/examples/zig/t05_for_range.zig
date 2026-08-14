// t05_for_range: `for (START..END) |i|` — Zig's range iteration desugars
// to a C for loop with a hoisted index (the c-sh-go t06_for shape).
const std = @import("std");

pub fn main() void {
    for (0..4) |i| {
        std.debug.print("{d}\n", .{i});
    }
    for (1..3) |k| {
        std.debug.print("k{d}\n", .{k});
    }
}
