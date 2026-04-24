# Rust · axum starter

Minimal [axum](https://github.com/tokio-rs/axum) service scaffold with a
binary/library split so tests can exercise the router without binding a TCP
port.

## Getting started

```bash
cargo fetch
cargo build
cargo run                    # starts the server on :3000
cargo test                   # runs the integration tests
cargo clippy -- -D warnings  # strict lint
```

## Layout

```
src/
  lib.rs     Router + handlers (hello, healthz)
  main.rs    Binary entrypoint — binds lib::app() to :3000
tests/
  hello.rs   Integration tests using tower::ServiceExt::oneshot
Cargo.toml   Deps + binary/library config
clippy.toml  Clippy overrides (empty default; edit as the project grows)
```

## Why this stack

- **axum** — Tokio-native web framework with strong type-driven handler
  signatures and excellent ergonomics around towers/middlewares.
- **tokio** — the de-facto async runtime for Rust services.
- **clippy** — strict linter; `-D warnings` promotes every warning to an
  error in CI.

Library + binary split keeps handlers unit-testable without spinning up a
real HTTP listener — `oneshot` feeds requests into the router and collects
the response synchronously.
