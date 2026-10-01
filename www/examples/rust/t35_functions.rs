// t35_functions — multi-fn programs: positional params (getVar("1")...
// bindings at fn entry), value returns via tail expressions AND explicit
// `return e;`, void calls (fnCall), nested value calls (fnValue).
fn twice(n: i64) -> i64 {
    n * 2
}

fn add(a: i64, b: i64) -> i64 {
    return a + b;
}

fn clamp(x: i64, hi: i64) -> i64 {
    if x > hi {
        return hi;
    }
    x
}

fn hello(n: i64) {
    println!("hello {}", n);
}

fn main() {
    println!("{}", twice(21));
    println!("{}", add(twice(3), 4));
    println!("{}", clamp(17, 10));
    println!("{}", clamp(5, 10));
    hello(3);
}
