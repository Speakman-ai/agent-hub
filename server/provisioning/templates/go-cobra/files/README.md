# Go · stdlib + cobra starter

Minimal Go CLI scaffold using [cobra](https://cobra.dev/) for the command tree
and Go's built-in testing package.

## Getting started

```bash
go mod tidy                  # fetch deps
go run . agent               # -> "Hello, agent!"
go test ./...                # run tests
golangci-lint run            # lint (install golangci-lint separately)
```

## Layout

```
main.go                program entrypoint — delegates to cmd.NewRootCommand
cmd/
  root.go              cobra wiring + the pure Hello() helper
  root_test.go         stdlib tests for Hello()
.golangci.yml          lint config covering the standard set
go.mod                 module manifest — edit the module path when you publish
```

## Why this stack

- **cobra** — de-facto standard for building Go CLIs (kubectl, helm, gh all
  use it). Easy subcommand composition and auto-generated help.
- **stdlib `testing`** — zero-dependency tests; golang.org/x integration is
  available when you need it.
- **golangci-lint** — meta-linter that bundles the community-consensus set
  (govet, staticcheck, errcheck, etc.) behind a single config.

Edit the module path in `go.mod` (`example.com/starter`) to something real
before you push.
