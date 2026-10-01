// t54_iter_chain — multi-step iterator pipelines: map (closure AND
// registered fn), filter with a PROVEN-bool predicate, take(N) capping
// the bound, and combinations. Each element flows through the steps in
// order; filters skip via Continue on a proven-bool temp.
fn double(n: i64) -> i64 {
    n * 2
}

fn main() {
    let nums = vec![5, 2, 8, 1, 4];

    // filter + map
    let big_doubled: Vec<i64> = nums.iter().map(|n| double(*n)).filter(|d| d > 4).collect();
    let mut s1 = 0;
    for d in big_doubled.iter() {
        s1 += *d;
    }
    println!("{}", s1);

    // filter alone
    let smalls: Vec<i64> = nums.iter().filter(|n| n < 3).collect();
    let mut s2 = 0;
    for n in smalls.iter() {
        s2 += *n;
    }
    println!("{}", s2);

    // take caps the loop
    let taken: Vec<i64> = nums.iter().take(2).collect();
    let mut s_t = 0;
    for x in taken.iter() {
        s_t += *x;
    }
    println!("{}", s_t);

    // map(fn-name) + filter + take combined
    let mixed: Vec<i64> = nums.iter().map(double).filter(|d| d >= 4).take(2).collect();
    let mut s3 = 0;
    for d in mixed.iter() {
        s3 += *d;
    }
    println!("{}", s3);
}
