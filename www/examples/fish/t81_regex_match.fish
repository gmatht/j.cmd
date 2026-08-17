# t81_regex_match: `string match -r` regex matching (the A1 Regex node)
# diagnostics: quiet ERE match in if conditions — match and no-match branches
set x "hello 42 world"
if string match -rq '[0-9]+' $x
    echo matched
else
    echo no-match
end
set y "no digits here"
if string match -rq '[0-9]+' $y
    echo matched
else
    echo no-match
end
set z "ABC"
if string match -rqi '^abc$' $z
    echo ci-ok
end
