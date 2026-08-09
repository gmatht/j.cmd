# t64_prefix_suffix: shortest/longest prefix & suffix removal
# diagnostics: program prints its result to stdout
x="hello"
echo "${x#he}"
echo "${x%lo}"
echo "${x##*l}"
echo "${x%%l*}"
