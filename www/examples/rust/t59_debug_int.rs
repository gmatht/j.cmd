// t59_debug_int — {:?} on PROVEN-integer arguments renders exactly like
// {} (Rust Debug == Display == decimal digits for ints); the frontend
// type-tracker proves each argument before allowing it. {:?} on strings
// would gain quotes/escapes (Debug != Display) and refuses.
fn main() {
    let n = 42;
    println!("n={:?}", n);
    let big = 1234567;
    println!("big={:?} end", big);
    let neg = 0 - 5;
    println!("neg={:?}", neg);
}
