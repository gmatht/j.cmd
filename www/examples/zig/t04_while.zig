// t04_while: while with and without the `: (update)` continue expression
// (PLAN_ZIG_F §3 — the update desugars to the body's last statement, the
// c-sh-go t05_while shape).
const std = @import("std");

pub fn main() void {
    var i: i32 = 0;
    while (i < 3) : (i += 1) {
        std.debug.print("w{d}\n", .{i});
    }
    var j: i32 = 5;
    while (j > 0) {
        std.debug.print("j{d}\n", .{j});
        j -= 1;
    }
}
