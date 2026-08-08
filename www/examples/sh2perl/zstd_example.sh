#!/bin/bash
zstd -dc /usr/lib/firmware/rp2.fw.zst > /tmp/rp2.fw
echo "Decompressed rp2 firmware"

echo "exit: $?"
