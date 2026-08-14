// t06_for_items: `for (arr) |it|` over an array literal — the capture
// becomes the loop index and the body reads arr[it] (the c-sh-go
// t45_array_iter shape).
const std = @import("std");

pub fn main() void {
    const items = [_]i32{ 10, 20, 30 };
    for (items) |it| {
        std.debug.print("{d}\n", .{it});
    }
}
