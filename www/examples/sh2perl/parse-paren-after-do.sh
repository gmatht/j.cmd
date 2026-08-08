#!/bin/sh
# Parse error: ParenClose unexpected after do { ... }
for pid in $(ls /proc); do {
	echo "$pid"
} 