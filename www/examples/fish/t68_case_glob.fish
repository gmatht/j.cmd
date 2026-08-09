# t68_case_glob: case dispatch with glob patterns
# diagnostics: program prints its result to stdout
switch hello
    case 'h*'
        echo star
    case '*l*' '*x*'
        echo alt
end
switch axl
    case 'h*'
        echo star2
    case '*l*' '*x*'
        echo alt2
end
