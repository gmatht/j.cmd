# t75_fish_func_scope: fish function definition + set -g scoping
# diagnostics: program prints its result to stdout
function greet
    echo "hi $argv[1]"
end
set -g name world
greet $name
echo "global=$name"
