// t14_fn_refuse — GENERIC functions refuse (fn_def: no generics yet).
// Plain multi-fn programs are SUPPORTED since v0.3 (t35_functions.rs);
// this pin moved to the current refusal boundary (was: any non-main fn).
// fn_def lowers EVERY non-main item (defs are emitted even when never
// called), so the emit refuses loudly — REFUSE > GUESS.
fn id<T>(x: T) -> T {
    x
}

fn main() {
    println!("x");
}
