# t70_quoted_single: single-quoted string literal (PPI Token::Quote::Single)
# diagnostics: program prints its result to stdout
# NOTE: single-quoted strings CONTAINING '$' are mis-lowered (interpolated)
# — recorded in frontends/coverage/bugs-perl-sh-go.txt; this example covers
# the correct subset.
$s = 'single quoted';
print "$s\n";
print 'raw text', "\n";
