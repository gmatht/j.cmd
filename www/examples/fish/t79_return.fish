# t79_return: fish return builtin — exit the function early with a status
# diagnostics: program prints its result to stdout
function f
    echo in-f
    return 3
    echo unreached
end
f
echo "status=$status"
