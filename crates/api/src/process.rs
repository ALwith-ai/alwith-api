//! 起子进程时的平台细节:Windows 下 spawn 不弹控制台。客户端 spawn Runtime、模块 spawn 自己的
//! 子进程都用它;非 Windows 是 no-op,调用点不用写 `#[cfg(windows)]`。

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub trait HideConsoleExt {
    fn hide_console(&mut self) -> &mut Self;
}

impl HideConsoleExt for std::process::Command {
    fn hide_console(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

impl HideConsoleExt for tokio::process::Command {
    fn hide_console(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}
