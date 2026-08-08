# Test that A && B || C chains work when B and C are assignments only
grep -q pattern file.txt &&
    result="${result} match" ||
    result="${result} no-match"
echo "$result"
