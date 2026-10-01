// t43_mut_refuse — `&mut` borrows refuse: writes through a mutable
// borrow are NOT representable in the value-store model (no aliasing).
// Shared `&T` borrows erase to value snapshots (t42_borrow_vec.rs).
fn main() {
    let mut n = 1;
    let r = &mut n;
    *r += 1;
    println!("{}", n);
}
