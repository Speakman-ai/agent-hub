//! Starter axum binary — binds the shared router from `lib.rs` to :3000.

use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let listener = TcpListener::bind("0.0.0.0:3000").await?;
    println!("listening on http://{}", listener.local_addr()?);
    axum::serve(listener, starter::app()).await?;
    Ok(())
}
