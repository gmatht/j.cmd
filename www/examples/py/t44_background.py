# t44_background: background job and wait
# diagnostics: program prints its result to stdout
import subprocess
p = subprocess.Popen(["echo", "bg"])
p.wait()
print("main")
