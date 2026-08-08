#!/bin/bash

# find command with backticks
#PERL_MUST_NOT_CONTAIN `find
found_files=`find . -name "*.sh" -type f`
echo "Found shell scripts:"
echo "$found_files"

# basename and dirname with backticks
#PERL_MUST_NOT_CONTAIN `basename
#PERL_MUST_NOT_CONTAIN `dirname
#script_name=`basename $0`
#script_dir=`dirname $0`
#echo "Script name: $script_name"
#echo "Script directory: $script_dir"
