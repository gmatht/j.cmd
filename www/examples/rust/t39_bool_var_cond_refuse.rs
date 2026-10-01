// t39_bool_var_cond_refuse — an UNPROVEN variable as a condition refuses
// (its store value could be anything; `$x` alone parses as a nonempty-
// string/file test, NOT a truthiness read). PROVEN-bool variables DO
// lower now (`$b = "true"` equality — exact); this pin covers the
// type-tracker's blind spot, where lowering would guess.
fn make() -> i64 {
    1
}

fn main() {
    let x = make();
    let b = x;
    if b {
        println!("taken");
    }
}
