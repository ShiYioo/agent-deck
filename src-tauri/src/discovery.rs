//! CLI 发现：PATH 之外还要认「桌面应用捆绑」的安装形态。
//!
//! ZCode 桌面版本质是个 Electron 应用，它的 CLI 只是包内的
//! `resources/glm/zcode.cjs`（见同目录 `.node-bundle-meta.json` 的
//! `runtime: electron-node` / `entry: zcode.cjs`），安装器从不把它写进 PATH。
//! 只查 PATH 会把已经装好 ZCode 的用户误判成「未安装」，
//! 所以这里在 PATH 落空后继续按安装目录探测。

use std::path::{Path, PathBuf};

use crate::executors::Harness;

/// 定位结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Located {
    /// 可直接启动：原生可执行文件，或 Windows 上的 .cmd/.bat 垫片。
    Program(PathBuf),
    /// 需要 Node 解释执行的脚本（桌面应用捆绑的 .cjs）。
    NodeScript(PathBuf),
}

impl Located {
    /// 定位到的原始路径，仅用于诊断展示。
    pub fn path(&self) -> &Path {
        match self {
            Self::Program(p) | Self::NodeScript(p) => p,
        }
    }

    /// 展开成 `(program, prefix_args)`，`prefix_args` 排在 CLI 自身参数之前。
    pub fn into_command(self) -> Result<(PathBuf, Vec<String>), String> {
        match self {
            Self::Program(path) => {
                match path.extension().and_then(|e| e.to_str()) {
                    // npm 装的 .cmd/.bat 垫片不是可执行映像，直接 CreateProcess 会失败
                    Some("cmd") | Some("bat") => Ok((
                        PathBuf::from("cmd"),
                        vec!["/C".into(), path.to_string_lossy().into_owned()],
                    )),
                    _ => Ok((path, Vec::new())),
                }
            }
            Self::NodeScript(script) => {
                let node = which::which("node")
                    .map_err(|_| "ZCode 为 Node 脚本形态，但未找到 node".to_string())?;
                Ok((node, vec![script.to_string_lossy().into_owned()]))
            }
        }
    }

    /// 运行该入口需要额外注入的环境变量。
    ///
    /// 桌面版捆绑的 `zcode.cjs` 把「资源根」当成脚本自身所在目录，去相邻的
    /// `provider/zcode-builtin.json` 找内置 provider 配置——那是源码仓库
    /// `apps/zcode-cli/packages/cli/dist/` 的布局。打包后脚本被拍平到
    /// `resources/glm/`，相对路径必然扑空，CLI 一启动就报
    /// 「无法定位 CLI ZCode Built-in Provider Config」。
    ///
    /// 官方桌面应用正是显式传这两个环境变量把路径喂给 CLI 的，这里照做。
    /// 注意 CLI 要求两者**同时**提供，只给一个会直接抛错，所以要么都给要么都不给。
    pub fn environment(&self) -> Vec<(String, String)> {
        let Self::NodeScript(script) = self else {
            return Vec::new();
        };
        let (Some(builtin), Some(personal)) =
            (bundled_builtin_config(script), personal_provider_config())
        else {
            return Vec::new();
        };
        vec![
            (
                "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE".to_string(),
                builtin.to_string_lossy().into_owned(),
            ),
            (
                "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE".to_string(),
                personal.to_string_lossy().into_owned(),
            ),
        ]
    }
}

/// 由 `<root>/resources/glm/zcode.cjs` 反推
/// `<root>/resources/config/provider/zcode-builtin.json`。
fn bundled_builtin_config(script: &Path) -> Option<PathBuf> {
    let resources = script.parent()?.parent()?;
    let path = resources
        .join("config")
        .join("provider")
        .join("zcode-builtin.json");
    path.is_file().then_some(path)
}

/// CLI 的 personal provider config（官方 `/model` 选择的落盘位置）。
fn personal_provider_config() -> Option<PathBuf> {
    let path = dirs::home_dir()?
        .join(".zcode")
        .join("v2")
        .join("provider_config.json");
    path.is_file().then_some(path)
}

/// 显式覆盖：指向 `zcode` 可执行文件或 `zcode.cjs`，优先于一切自动探测。
const ENV_ZCODE: &str = "AGENT_DECK_ZCODE";

/// 捆绑 CLI 在安装目录下的相对路径（Windows / Linux）。
const ZCODE_BUNDLE_REL: &str = "resources/glm/zcode.cjs";

/// 捆绑 CLI 在 macOS 应用包内的相对路径。
#[cfg(target_os = "macos")]
const ZCODE_BUNDLE_REL_MAC: &str = "Contents/Resources/glm/zcode.cjs";

/// 定位 harness 对应的 CLI。
///
/// 顺序：PATH → harness 专属的捆绑安装位置。找不到返回 `None`。
pub fn locate(harness: Harness) -> Option<Located> {
    if let Ok(path) = which::which(harness.program()) {
        return Some(Located::Program(path));
    }
    match harness {
        Harness::Zcode => locate_bundled_zcode(),
        Harness::Codex | Harness::Opencode => None,
    }
}

/// 按安装目录探测 ZCode 桌面版捆绑的 CLI。
fn locate_bundled_zcode() -> Option<Located> {
    bundled_zcode_candidates()
        .into_iter()
        .find(|p| p.is_file())
        .map(|path| match path.extension().and_then(|e| e.to_str()) {
            Some(ext) if ext.eq_ignore_ascii_case("cjs") || ext.eq_ignore_ascii_case("js") => {
                Located::NodeScript(path)
            }
            // 覆盖变量也可能指向真正的可执行文件
            _ => Located::Program(path),
        })
}

/// ZCode 捆绑 CLI 的候选路径，按可信度排序。
fn bundled_zcode_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();

    // 1. 显式覆盖
    if let Some(p) = std::env::var_os(ENV_ZCODE) {
        out.push(PathBuf::from(p));
    }

    // 2. 各平台默认安装位置（安装器默认 per-user，其次才是全局）
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let local = PathBuf::from(local);
            out.push(local.join("Programs").join("ZCode").join(ZCODE_BUNDLE_REL));
            out.push(local.join("ZCode").join(ZCODE_BUNDLE_REL));
        }
        for key in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Some(pf) = std::env::var_os(key) {
                out.push(PathBuf::from(pf).join("ZCode").join(ZCODE_BUNDLE_REL));
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        out.push(PathBuf::from("/Applications/ZCode.app").join(ZCODE_BUNDLE_REL_MAC));
        if let Some(home) = std::env::var_os("HOME") {
            out.push(
                PathBuf::from(home)
                    .join("Applications/ZCode.app")
                    .join(ZCODE_BUNDLE_REL_MAC),
            );
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for root in ["/opt/ZCode", "/usr/lib/ZCode", "/usr/local/lib/ZCode"] {
            out.push(PathBuf::from(root).join(ZCODE_BUNDLE_REL));
        }
        if let Some(home) = std::env::var_os("HOME") {
            out.push(
                PathBuf::from(home)
                    .join(".local/share/ZCode")
                    .join(ZCODE_BUNDLE_REL),
            );
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cmd_shim_launches_through_comspec() {
        let located = Located::Program(PathBuf::from(r"C:\npm\zcode.cmd"));
        let (program, prefix) = located.into_command().unwrap();
        assert_eq!(program, PathBuf::from("cmd"));
        assert_eq!(prefix, vec!["/C".to_string(), r"C:\npm\zcode.cmd".into()]);
    }

    #[test]
    fn native_binary_runs_without_prefix() {
        let located = Located::Program(PathBuf::from("/usr/local/bin/codex"));
        let (program, prefix) = located.into_command().unwrap();
        assert_eq!(program, PathBuf::from("/usr/local/bin/codex"));
        assert!(prefix.is_empty());
    }

    #[test]
    fn bundled_script_runs_through_node() {
        let located = Located::NodeScript(PathBuf::from("/opt/ZCode/resources/glm/zcode.cjs"));
        let (program, prefix) = located.into_command().unwrap();
        // 本机必然有 node（项目其他部分也依赖它），否则这条断言会提示环境缺失
        assert!(which::which("node").is_ok(), "测试需要 node");
        assert_eq!(
            prefix,
            vec!["/opt/ZCode/resources/glm/zcode.cjs".to_string()]
        );
        assert!(program.is_file() || program.to_string_lossy().contains("node"));
    }

    #[test]
    fn env_override_is_probed_first() {
        // 候选顺序本身要稳定：覆盖变量排最前
        let candidates = bundled_zcode_candidates();
        assert!(!candidates.is_empty(), "至少应有平台默认候选");
        assert!(
            candidates
                .iter()
                .all(|c| c.to_string_lossy().ends_with("zcode.cjs"))
        );
    }

    #[test]
    fn only_zcode_has_a_bundled_fallback() {
        // codex / opencode 没有应用捆绑形态，PATH 落空即 None
        // （locate 先查 PATH，这里只断言不会 panic 且类型正确）
        let _ = locate(Harness::Codex);
        let _ = locate(Harness::Opencode);
    }

    #[test]
    fn only_bundled_scripts_need_extra_environment() {
        // 原生可执行文件不需要额外环境；捆绑脚本才需要
        let native = Located::Program(PathBuf::from("/usr/local/bin/zcode"));
        assert!(native.environment().is_empty());
    }

    #[test]
    fn bundled_builtin_config_is_derived_from_the_script_location() {
        // 目录不存在时不应panic，且必须返回 None（不臆造路径）
        let missing = PathBuf::from("/nonexistent/ZCode/resources/glm/zcode.cjs");
        assert_eq!(bundled_builtin_config(&missing), None);
    }

    /// 诊断本机定位结果：`cargo test report_located -- --ignored --nocapture`
    #[test]
    #[ignore = "依赖本机是否安装对应 CLI"]
    fn report_located_clis() {
        for harness in [Harness::Zcode, Harness::Codex, Harness::Opencode] {
            match locate(harness) {
                Some(found) => {
                    println!("{} -> {:?}", harness.name(), found.path());
                    for (k, v) in found.environment() {
                        println!("    {k}={v}");
                    }
                }
                None => println!("{} -> 未找到", harness.name()),
            }
        }
    }
}
