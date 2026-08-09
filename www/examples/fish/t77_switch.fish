# t77_switch: fish switch statement
# diagnostics: program prints its result to stdout
set x apple
switch $x
    case apple
        echo fruit
    case carrot
        echo veg
    case '*'
        echo other
end
