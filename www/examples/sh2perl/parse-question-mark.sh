# Question mark unexpected - often from $? in certain contexts
# or from malformed ${var?} expansion
if [ $? -eq 0 ]; then
  echo "success"
fi
