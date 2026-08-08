# Parameter expansion with ## (remove longest prefix)
# The # inside ${} can confuse the lexer's Comment regex
echo "${0##*/}"
