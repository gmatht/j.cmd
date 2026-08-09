# t78_set_local: fish set -l local scope in functions
# diagnostics: program prints its result to stdout
function inner
    set -l v 1
    echo "inner=$v"
end
set v 2
inner
echo "outer=$v"

// DRIVER: frontend emit gap (red gate — the worker's work item).
