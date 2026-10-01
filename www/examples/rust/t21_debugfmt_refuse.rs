// t21_debugfmt_refuse — {:?} on a STRING argument refuses: Debug wraps
// strings in quotes and escapes (\n, \", ...) unlike Display. Ints are
// exact (Debug == Display == decimal) and supported (t59_debug_int.rs).
fn main() {
    let s = "hi";
    println!("{:?}", s);
}
