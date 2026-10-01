// t55_tuples_fnvals — tuples lower to native arrays (`(a, b)` literal,
// `.N` computed index reads), and fn items used as values carry their
// REGISTERED name: an indirect call `f(2)` through a tracked Fn var
// resolves to its registered target at compile time.
fn scale(n: i64) -> i64 {
    n * 10
}

fn main() {
    let pair = (3, 4);
    println!("{} {}", pair.0, pair.1);
    let mixed = (10, "hi");
    println!("{}", mixed.0);
    let f = scale;
    let r = f(2);
    println!("{}", r);
}
