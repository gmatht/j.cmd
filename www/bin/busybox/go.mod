module github.com/gmatht/sh2loop/frontends/busybox

go 1.21

require (
	github.com/gmatht/sh2loop/frontends/c-sh-go v0.0.0
	github.com/gmatht/sh2loop/frontends/fish-sh-go v0.0.0
	github.com/gmatht/sh2loop/frontends/go-sh v0.0.0
	github.com/gmatht/sh2loop/frontends/perl-sh-go v0.0.0
	github.com/gmatht/sh2loop/frontends/py-sh-go v0.0.0
	github.com/gmatht/sh2loop/frontends/shir-emit-go v0.0.0
	github.com/gmatht/sh2loop/frontends/zsh-sh-go v0.0.0
)

replace github.com/gmatht/sh2loop/frontends/c-sh-go => ../c-sh-go

replace github.com/gmatht/sh2loop/frontends/fish-sh-go => ../fish-sh-go

replace github.com/gmatht/sh2loop/frontends/go-sh => ../go-sh

replace github.com/gmatht/sh2loop/frontends/perl-sh-go => ../perl-sh-go

replace github.com/gmatht/sh2loop/frontends/py-sh-go => ../py-sh-go

replace github.com/gmatht/sh2loop/frontends/shir-emit-go => ../shir-emit-go

replace github.com/gmatht/sh2loop/frontends/zsh-sh-go => ../zsh-sh-go
