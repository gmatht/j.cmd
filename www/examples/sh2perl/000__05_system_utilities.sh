#!/bin/bash

# System utilities with backticks
# This file demonstrates using backticks with system utility commands

echo "=== System Utilities ==="

# date command with backticks
#PERL_MUST_NOT_CONTAIN `date
#timestamp=`date +%r`
formatted_date=`date '+%Y-%m-%d'`
#echo "Timestamp: $timestamp"
echo "Formatted date: $formatted_date"

# time command with backticks
#PERL_MUST_NOT_CONTAIN `time
#time_result=`(time sleep 1) 2>&1 | sed s/...$//`
#echo "Time result: $time_result"

# sleep command with backticks (though it doesn't produce output)
#PERL_MUST_NOT_CONTAIN `sleep
#sleep_duration=`echo "2"`
#echo "Sleeping for $sleep_duration seconds..."
#sleep $sleep_duration

# which command with backticks
#PERL_MUST_NOT_CONTAIN `which
#bash_path=`which bash`
#echo "Bash path: $bash_path"

# yes command with backticks
#PERL_MUST_NOT_CONTAIN `yes
yes_result=`yes "Hello" | head -3`
echo "Yes command result:"
echo "$yes_result"

