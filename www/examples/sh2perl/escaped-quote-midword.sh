#!/bin/bash
# A single-quoted word followed by a backslash-escaped quote is ONE word
# (`'a'\''b'` -> a'b), but when the escaped-quote word has a SEPARATE
# predecessor (`x \''y'`) bash keeps TWO words. The parser produces the same
# AST shape for both; the transform's quote-merge must not glue `x 'y`
# into `x'y`. See harness/check_ast.pl (beh_escaped_quote_midword).
echo x \''y'
