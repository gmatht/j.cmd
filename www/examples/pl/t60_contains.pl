# t60_contains: substring containment
# diagnostics: program prints its result to stdout
my $s = "hello world";
print index($s, "world") >= 0 ? "has\n" : "no\n";
print index($s, "nope") >= 0 ? "has2\n" : "no2\n";
