//! ALwith's app-side Rust: the types of the `alwith-runtime-v1` protocol (always present) and the
//! client (feature `client`, on by default).
//! Protocol definitions are exported from the Runtime binary; Runtime never depends on this client
//! crate.

mod protocol;
pub use protocol::*;

mod engine;
pub use engine::{EngineManifestError, engine_from_manifest};

#[cfg(feature = "client")]
mod client;
#[cfg(feature = "client")]
pub use client::*;
/// Platform details for spawning child processes (hiding the console on Windows, etc.), shared by
/// module subprocesses and the host.
#[cfg(feature = "client")]
pub mod process;
