// t34_bools — boolean literals as VALUES (`let b = true;`) and as
// CONDITIONS (`if true`, `while false`). The A1 Bool expr renders to a
// native JS boolean, which prints like Rust's `{}` bool formatting;
// literal-bool conditions fold to always-true / always-false tests.
fn main() {
    let b = true;
    let c = false;
    println!("{} {}", b, c);
    if true {
        println!("taken");
    }
    if false {
        println!("not taken");
    }
    let mut n = 0;
    while false {
        n += 1;
    }
    println!("n={}", n);
}
