#!/bin/bash
# Complex nested case/esac — tests deep case statement parsing
# (pre-existing parser limitation)
case "$1" in
    start)
        echo "Starting..."
        case "$2" in
            fast) echo "Fast start" ;;
            slow) echo "Slow start" ;;
        esac
        ;;
    stop)
        echo "Stopping..."
        ;;
    restart)
        echo "Restarting..."
        case "$2" in
            soft) echo "Soft restart" ;;
            hard) echo "Hard restart" ;;
        esac
        ;;
esac
