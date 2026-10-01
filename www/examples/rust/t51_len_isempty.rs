// t51_len_isempty — Vec/slice len() lowers to the array's .length field
// read (the store keeps native arrays); is_empty() folds to length==0 in
// conditions (hoisted — If conditions evaluate once). contains(&x) maps
// to the exact JS .includes.
fn main() {
    let v = vec![10, 20, 30];
    if v.is_empty() {
        println!("empty");
    } else {
        println!("not empty");
    }
    if !v.is_empty() {
        println!("has items");
    }
    // NOTE: Vec::contains still refuses — the runtime's getVar returns
    // the scalar view of an array var, so no exact JS member read exists
    // yet (arrayItems-based lowering is a later tranche).
    // NOTE: str::len() stays REFUSED — Rust len() is BYTES, JS .length
    // is UTF-16 units (differ for non-ASCII); guessing would be wrong.
    let s = "hello";
    if !s.is_empty() {
        println!("s non-empty");
    }
    while false {
        println!("never");
    }
}
