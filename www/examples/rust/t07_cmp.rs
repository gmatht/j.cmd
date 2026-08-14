fn main() {
    let a = 5;
    let b = 5;
    if a == b { println!("eq"); }
    if a != 3 { println!("ne"); }
    if a >= 5 && b <= 5 { println!("both"); }
    if a > 2 || b < 1 { println!("or"); }
    if !(a == 1) { println!("not"); }
}
