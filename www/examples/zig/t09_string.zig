// t09_string: `[]const u8` string slices — `{s}` printing, `s[0]`
// indexing, `s.len` → strlen (the c-sh-go t10_string_pointer/t13_strlen
// shape).
const std = @import("std");

pub fn main() void {
    const s: []const u8 = "hello";
    std.debug.print("{s}\n", .{s});
    std.debug.print("{c}\n", .{s[0]});
    std.debug.print("{d}\n", .{s.len});
}
