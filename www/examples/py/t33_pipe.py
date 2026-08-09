# t33_pipe: pipe between commands
# diagnostics: program prints its result to stdout
import subprocess
out = subprocess.run(["echo", "hello"], capture_output=True, text=True)
print(out.stdout.strip())
