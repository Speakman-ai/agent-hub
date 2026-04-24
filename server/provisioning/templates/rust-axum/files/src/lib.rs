//! Starter axum service library.
//!
//! Exposing the router as a library makes it trivial to exercise via
//! `tower::ServiceExt::oneshot` in tests without binding a TCP port.

use axum::{routing::get, Router};

/// Root handler — returns the canonical hello greeting.
pub async fn hello() -> &'static str {
    "Hello, world!"
}

/// Liveness probe — always returns ok.
pub async fn healthz() -> &'static str {
    "ok"
}

/// Build the top-level router used by both the binary and the tests.
pub fn app() -> Router {
    Router::new()
        .route("/", get(hello))
        .route("/healthz", get(healthz))
}
