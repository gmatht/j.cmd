# t31_case_switch: case/switch dispatch
# diagnostics: program prints its result to stdout
set x 2
switch $x
    case 1
        echo one
    case 2
        echo two
    case '*'
        echo other
end
