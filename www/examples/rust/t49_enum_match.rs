// t49_enum_match — UNIT-variant enums: variants lower to their qualified
// tag strings ("Color::Red"), match lowers to an if-chain of string
// equality tests on a hoisted scrutinee, or-patterns join with -o, `_`
// is the fall-through. Payload variants (tuple/struct) still refuse —
// they need record storage.
#[derive(PartialEq)]
enum Color {
    Red,
    Green,
    Blue,
}

// NOTE: the param is deliberately NOT named `c` — A1 function params
// bind into the shared global store (c-sh-go protocol), so a param name
// colliding with a caller's variable would clobber it until per-function
// locals land (see ROADMAP known limitations).
fn name_of(col: Color) -> &'static str {
    match col {
        Color::Red => "warm",
        Color::Green | Color::Blue => "cool",
    }
}

fn main() {
    let c = Color::Green;
    let mut label = "";
    match c {
        Color::Red => label = "r",
        Color::Green => label = "g",
        Color::Blue => label = "b",
    }
    println!("{}", label);
    if c == Color::Green {
        println!("is green");
    }
    println!("{}", name_of(Color::Red));
    println!("{}", name_of(c));  // MOVES c — must be the last use
}
