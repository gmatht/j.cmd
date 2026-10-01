// t42_borrow_vec — shared borrows erase to value snapshots (exact: while
// a `&T` borrow lives Rust forbids mutation through the original, so a
// snapshot has precisely the borrow's observable semantics), and
// `vec![a, b, c]` lowers to a native array literal (the store keeps real
// JS arrays). The vec itself is only passed/aliased here — element reads
// (indexing) are a later tranche.
fn main() {
    let s = "hi";
    let r = &s;
    println!("{}", r);
    let n = 5;
    let rn = &n;
    println!("{}", rn + 1);
    let v = vec![10, 20, 30];
    let w = &v;
    let also = w;
    let mut total = 0;
    for i in 0..3 {
        total += i;
    }
    println!("{}", total);
}
