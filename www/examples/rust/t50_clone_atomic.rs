// t50_clone_atomic — .clone() deep-copies ANY store value (the Rust
// Clone bound never aliases — structuredClone in JS), and AtomicBool
// statics are plain value read/write single-threaded (new/load/store).
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(PartialEq, Clone)]
enum Mode {
    On,
    Off,
}

static FLAG: AtomicBool = AtomicBool::new(false);

fn main() {
    let s = String::from("orig");
    let t = s.clone();
    println!("{}", t);
    let v = vec![1, 2, 3];
    let w = v.clone();
    let _keep = w;
    let mut total = 0;
    for i in 0..4 {
        total += i;
    }
    println!("{}", total);
    FLAG.store(true, Ordering::Relaxed);
    if FLAG.load(Ordering::Relaxed) == true {
        println!("flag set");
    }
    let m = Mode::Off;
    let _m2 = m.clone();
}
