# t53_param_default: environment default value
# diagnostics: program prints its result to stdout
import os
x = os.environ.get("x", "def")
print("a=" + x)
x = "set"
print("b=" + x)
