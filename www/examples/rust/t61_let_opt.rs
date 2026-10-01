// t61_let_opt — Option<T> under the None≡"" convention:
// Some(v)/None constructors pass through; as_deref().unwrap_or("")
// collapses to the plain variable read. NOTE: `match opt { Some(x) =>
// .. }` payload-pattern arms are a gated tranche (needs payload enums).
fn greet() -> &'static str {
    "stranger"
}

fn main() {
    let o1 = Some("present");
    println!("{}", o1.as_deref().unwrap_or(""));
    let none: Option<&str> = None;
    println!("{}", none.as_deref().unwrap_or(""));
    let g = Some("alice");
    if let Some(_x) = g {
        println!("{}", greet());
    }
}
