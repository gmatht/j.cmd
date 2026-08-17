// t16_assign: the plain assignment STATEMENT `x = e;` — the canonical
// assignment_expression shape (ident LHS, `=` operator, expr RHS).
// t04 pins only the compound ops (`i += 1`, `j -= 1`), t08 the deref
// write `p.* = e`, t14 `b = !b` as a unary carrier — none pins the
// plain `x = e;` form. assignOrCallStmt() maps it 1:1 onto C's
// `x = e;`, and clib lowers it to the A1 Assign node.
const std = @import("std");

pub fn main() void {
    var x: i32 = 1;
    x = 5;
    std.debug.print("{d}\n", .{x});
    x = x + 1;
    std.debug.print("{d}\n", .{x});
    var y: i32 = 10;
    y = x * 2;
    std.debug.print("{d}\n", .{y});
    x = y;
    std.debug.print("{d}\n", .{x});
}
