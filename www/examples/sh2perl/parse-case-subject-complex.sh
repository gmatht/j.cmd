# Test that a case subject can contain backtick command substitution
# e.g., case $1-`uname -s` in ... esac
case $1-$(uname -s) in
  regex-Linux) echo "Linux" ;;
  regex-*) echo "Other: $(uname -s)" ;;
esac
