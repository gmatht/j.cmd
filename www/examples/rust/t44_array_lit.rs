// t44_array_lit — `[a, b, c]` array literals lower to native array
// literals (the store keeps real JS arrays), same as vec![..] (t42).
// NOTE: arrays are only aliased/passed here — element reads (indexing)
// and .len() on arrays are later tranches.
fn main() {
    let pair = [1, 2];
    let copy = pair;
    let mut total = 0;
    for i in 0..3 {
        total += i;
    }
    println!("{} {}", total, 7);
}
