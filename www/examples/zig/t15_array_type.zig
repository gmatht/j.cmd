// t15_array_type: explicitly sized array types `[N]i32` — the
// tree-sitter-zig array_type node (t06 pins only the inferred `[_]i32`
// RHS form; t09 pins the `[]const u8` slice_type). decl()/bracketedType()
// accept a numeric length and emit `int name[N] = {...};`; the for-items
// shape (t06) then iterates the C array.
const std = @import("std");

pub fn main() void {
    const arr: [3]i32 = .{ 10, 20, 30 };
    for (arr) |it| {
        std.debug.print("{d}\n", .{it});
    }
    const fixed: [2]i32 = .{ 7, 9 };
    for (fixed) |it| {
        std.debug.print("f{d}\n", .{it});
    }
}
