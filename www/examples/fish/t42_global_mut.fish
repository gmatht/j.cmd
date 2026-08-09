# t42_global_mut: function mutates a global
# diagnostics: program prints its result to stdout
set -g g 0
function f
    set -g g 1
end
f
echo $g
