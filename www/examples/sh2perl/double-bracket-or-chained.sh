# Demonstrate chained [[ ... ]] with || operators
# Parser failed with: Unexpected token: Or
if [[ -d /efi/Default ]] || [[ -d /boot/Default ]]; then
    echo "found"
fi

echo "exit: $?"
