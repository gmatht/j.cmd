// t11_switch: `switch (v) { prongs..., else => }` — each arm desugars to
// `case N: stmts; break;`, else to `default:` (the c-sh-go
// t20_switch/t52_switch_many shape).
const std = @import("std");

pub fn main() void {
    const x = 2;
    switch (x) {
        1 => std.debug.print("one\n", .{}),
        2 => std.debug.print("two\n", .{}),
        else => std.debug.print("other\n", .{}),
    }
    const y = 9;
    switch (y) {
        1 => std.debug.print("one\n", .{}),
        else => std.debug.print("other\n", .{}),
    }
}
