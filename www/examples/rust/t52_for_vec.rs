// t52_for_vec — for-loops over Vec/array elements: `for x in v.iter()`,
// by-value `for x in v`, and element reads. The length hoists ONCE
// (Rust's borrow checker forbids mutation during iteration — exact);
// each element binds via arrayIndex(v, __i).
fn main() {
    let words = vec!["alpha", "beta", "gamma"];
    for w in words.iter() {
        println!("{}", w);
    }
    let nums = vec![1, 2, 3];
    let mut total = 0;
    for n in nums.iter() {
        total += *n;
    }
    println!("{}", total);
    for n in 0..3 {
        total += n;
    }
    println!("{}", total);
}
