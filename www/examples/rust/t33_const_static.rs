// t33_const_static — top-level `const NAME: T = e;` / `static NAME: T = e;`
// items (immutable globals). Initialized BEFORE main runs regardless of
// source position; lowering prepends the assignments.
const LIMIT: i64 = 3;
static GREETING: &str = "hey";

fn main() {
    let mut total = 0;
    for i in 0..LIMIT {
        total += i;
    }
    println!("{} {}", GREETING, total);
}
