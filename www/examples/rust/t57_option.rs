// t57_option — Option<T> under the None≡"" store convention:
// Some(v) IS v (payload passthrough), None IS "" — so as_deref /
// unwrap_or("") collapse to the plain variable read (exact whenever no
// code distinguishes Some("") from None, the c-sh-go null→"" idiom).
fn show(pre: Option<&str>, nm: Option<&str>) {
    let a = pre.as_deref().unwrap_or("");
    let b = nm.as_deref().unwrap_or("");
    println!("{}|{}", a, b);
}

fn main() {
    show(Some("hello"), None);
    let x = Some("world");
    show(x, None);
    let empty: Option<&str> = None;
    show(empty, Some("fallback"));
}
