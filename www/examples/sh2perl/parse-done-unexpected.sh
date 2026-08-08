# Unexpected end of input while looking for 'done'
# Often from unbalanced while/for loops
# or from the lexer not producing enough Done tokens
while true; do
  echo "loop"
  if true; then
    break
  fi
done

result="ok"
echo "status: ${result}"
