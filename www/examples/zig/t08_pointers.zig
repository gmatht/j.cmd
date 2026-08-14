// t08_pointers: `const p: *i32 = &x;` and the `p.*` deref read/write —
// identical to the C mem seam (the c-sh-go t08_pointer/t09_pointer_alias
// shape). The pointer binding is const (the pointee stays mutable).
const std = @import("std");

pub fn main() void {
    var x: i32 = 5;
    const p: *i32 = &x;
    std.debug.print("a={d}\n", .{p.*});
    p.* = 7;
    std.debug.print("b={d}\n", .{x});
    const q: *i32 = p;
    q.* = 9;
    std.debug.print("c={d}\n", .{x});
}
