set -e
x=42
echo "x=$x"
echo "len=${#x}"
echo "default=${x:-none}"
echo "assign=${y:=assigned}"
echo "slice=${x:0:1}"
echo "upper=${x^^}"
echo "lower=${x,,}"
echo "strip=${x%%2}"
echo "sub=${x/4/5}"
echo "empty=${empty:-fallback}"
y="hello world"
echo "words: $y"
for w in $y; do
  echo "word=$w"
done
