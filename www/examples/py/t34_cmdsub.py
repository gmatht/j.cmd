# t34_cmdsub: command substitution
# diagnostics: program prints its result to stdout
import subprocess
x = subprocess.run(["echo", "hi"], capture_output=True, text=True).stdout.strip()
print(x)
