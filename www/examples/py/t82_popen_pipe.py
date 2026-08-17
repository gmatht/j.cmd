# t82_popen_pipe: Popen pipe chain → A1 Pipeline (a | b)
# diagnostics: program prints its result to stdout
import subprocess
p1 = subprocess.Popen(["echo", "hi"], stdout=subprocess.PIPE)
p2 = subprocess.Popen(["grep", "hi"], stdin=p1.stdout)
p2.wait()
