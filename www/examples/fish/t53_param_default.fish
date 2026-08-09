# t53_param_default: parameter default value
# diagnostics: program prints its result to stdout
if set -q x
    echo "a=$x"
else
    echo "a=def"
end
set x set
echo "b=$x"
