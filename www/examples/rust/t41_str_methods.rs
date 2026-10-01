// t41_str_methods — string-receiver methods whose Rust->JS mapping is
// 1:1 and pure: contains->includes, starts_with->startsWith,
// ends_with->endsWith, trim/trim_start/trim_end,
// to_lowercase/to_uppercase. The A1 MethodCall renders as a NATIVE JS
// member call. Receiver types come from the minimal type tracker
// (params/literals/annotations); anything unproven refuses.
fn main() {
    let s = "  Hello Rust World  ";
    println!("{}", s.trim());
    println!("{}", s.to_lowercase());
    println!("{}", "abc".to_uppercase());
    println!("{}", "hello world".contains("lo wo"));
    println!("{}", "hello".starts_with("he"));
    println!("{}", "hello".ends_with("lo"));
}
