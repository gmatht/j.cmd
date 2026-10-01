// t60_try_option — `expr?` propagates an EMPTY value by returning ""
// from the enclosing fn (Option propagation under the None≡""
// convention); non-empty values unwrap and flow. Exact when callers
// treat "" as None — they do, by the same convention.
fn maybe_word(n: i64) -> Option<&'static str> {
    if n > 0 {
        Some("positive")
    } else {
        None
    }
}

fn echo(n: i64) -> Option<&'static str> {
    let w = maybe_word(n)?;
    Some(w)
}

fn main() {
    println!("{}", echo(1).unwrap_or(""));
    println!("{}", echo(0 - 1).unwrap_or(""));
}
