// t48_if_value — if-as-expression: `let x = if c {A} else {B}` binds x in
// EVERY branch (rustc guarantees all paths produce a value), fn tails
// return per-branch, and else-if chains recurse. Conditions use the test
// grammar; branch values lower as ordinary expressions.
fn classify(n: i64) -> i64 {
    if n < 0 {
        0 - 1
    } else if n == 0 {
        0
    } else {
        1
    }
}

fn main() {
    let a = 5;
    let tag = if a > 3 { "big" } else { "small" };
    println!("{}", tag);
    let mut hits = 0;
    for i in 0..3 {
        if i == 1 {
            hits += 10;
        } else {
            hits += 1;
        }
    }
    println!("{}", hits);
    println!("{}", classify(0 - 7));
    println!("{}", classify(0));
    println!("{}", classify(9));
}
