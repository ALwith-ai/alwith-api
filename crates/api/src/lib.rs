//! ALwith 的应用侧 Rust:`alwith-runtime-v1` 协议的类型(总是有)与客户端(feature `client`,默认开)。
//! Protocol definitions are exported from the Runtime binary; Runtime never depends on this client crate.

mod protocol;
pub use protocol::*;

#[cfg(feature = "client")]
mod client;
#[cfg(feature = "client")]
pub use client::*;
/// 起子进程时的平台细节(Windows 隐藏控制台等),模块子进程和宿主共用。
#[cfg(feature = "client")]
pub mod process;
