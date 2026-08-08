# [[ ]] separated by || in if condition
if [[ -d /efi/Default ]] || [[ -d /boot/Default ]]; then
    echo "found"
fi

echo "exit: $?"
