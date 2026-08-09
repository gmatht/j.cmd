# t53_param_default: parameter expansion default value
# diagnostics: program prints its result to stdout
x=""
echo "a=${x:-def}"
x="set"
echo "b=${x:-def}"
