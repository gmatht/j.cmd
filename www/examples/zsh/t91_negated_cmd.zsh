# t91_negated_cmd: statement-level command negation — tree-sitter-zsh
# negated_command (`!` prefix on a whole command, distinct from t27's
# `!` inside a [[ ]] test expression). Lowers to the A1 Not node.
# diagnostics: program prints its result to stdout
! false
echo "exit=$?"
! true
echo "exit2=$?"
