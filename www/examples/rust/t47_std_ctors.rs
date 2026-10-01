// t47_std_ctors — std constructors with exact store-native values:
// String::from(x) IS x; String::new() is ""; Vec::new() and the map/set
// constructors are empty arrays.
fn main() {
    let s = String::from("hello");
    println!("{}", s);
    let t = String::new();
    println!("{}!", t);
    let v: Vec<i64> = Vec::new();
    let w: Vec<String> = Vec::new();
    let _m: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    // NOTE: observable uses of the collections (.len() in arith or
    // conditions) refuse until call-hoisting lands; here they only need
    // to lower + store the right values.
    let _unused_v = &v;
    let _unused_w = &w;
}
