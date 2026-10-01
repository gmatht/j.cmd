// t36_decls — declaration-only items and associated functions:
// struct/enum/type/trait items accepted as declarations (every USE still
// refuses at its own site), inline `mod` flattened, `macro_rules!`
// definitions dropped (unknown invocations still refuse), inherent impl
// methods lowered under mangled `Type_method` names and called as
// `Type::method(...)`, `#[cfg(test)]` subtrees dropped.
struct Point {
    x: i64,
    y: i64,
}

enum Color {
    Red,
    Green,
}

type Pair = (i64, i64);

trait Shape {
    fn area(&self) -> i64;
}

mod math {
    pub const TWO: i64 = 2;
    pub fn triple(n: i64) -> i64 {
        n * 3
    }
}

impl Point {
    fn zero_x(x: i64) -> i64 {
        x - x
    }
}

macro_rules! unused_macro {
    () => {};
}

#[cfg(test)]
mod tests {
    #[test]
    fn never_built() {
        panic!("test-only code does not exist in a normal build");
    }
}

fn main() {
    println!("{}", Point::zero_x(7));
    // NOTE: `math::triple(5)` refuses today — mod-nested fns register
    // under their bare name (`triple`), so qualified mod-paths are not
    // call targets yet (only Type::method mangling resolves).
}
