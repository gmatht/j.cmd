# t45_env_set: set an environment variable
# diagnostics: program prints its result to stdout
import os
os.environ["X"] = "v"
print(os.environ["X"])
