// t32_typed_lets — `let` with type annotations (`let x: i64 = ...`,
// `let mut s: &str = ...`). The annotation wraps the ident pattern
// (Pat::Type) and is ERASED — the store is dynamically typed.
fn main() {
    let x: i64 = 42;
    let mut y: i64 = 7;
    let s: &str = "hello";
    let mut t: &str;
    t = "world";
    y += x;
    println!("{} {} {} {}", x, y, s, t);
}
