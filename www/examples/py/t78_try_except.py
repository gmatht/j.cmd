# t78_try_except: try/except/finally guards a block (try_stmt)
# diagnostics: program prints its result to stdout
try:
    print("in try")
except:
    print("caught")
finally:
    print("final")
print("after")
