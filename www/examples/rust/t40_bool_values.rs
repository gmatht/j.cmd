// t40_bool_values — comparisons / && / || / ! as VALUES: the fleet
// convention (py-sh-go CompareE) lowers them to `test` calls, which the
// runtime evaluates to native JS booleans — printing exactly like Rust's
// bool `{}` formatting. Comparison operands are ints/int-vars (string
// comparison refuses in the test grammar).
fn main() {
    let a = 3;
    let b = 7;
    let lt = a < b;
    let eq = a == 3;
    let ne = a != b;
    let both = a < b && a == 3;
    let either = a > b || a == 3;
    let not = !(a < b);
    println!("{} {} {} {} {} {}", lt, eq, ne, both, either, not);
    if a < b {
        println!("cmp cond");
    }
    if a > b && a != 3 {
        println!("not taken");
    }
}
