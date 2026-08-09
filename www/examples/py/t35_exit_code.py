# t35_exit_code: capture the exit code
# diagnostics: program prints its result to stdout
import subprocess
r = subprocess.run(["false"])
print(r.returncode)
