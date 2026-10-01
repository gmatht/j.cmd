// t31_use — `use` imports. They name things for the TYPE CHECKER only and
// have no runtime effect; lowering drops them.
use std::collections::HashMap;
use std::fmt;

fn main() {
    let x = 5;
    println!("x={}", x);
}
