# t70_unset: unset removes a variable
# diagnostics: program prints its result to stdout
x=5
unset x
echo "${x:-gone}"
