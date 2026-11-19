//! An engine entry of `ALWITH_RUNTIME_ENGINES`, read from the manifest that was staged with the engine.
//!
//! Whoever packages an engine knows how it starts: the command, its arguments and its environment.
//! The host only knows where the files ended up. The manifest holds the first, with a `${name}`
//! placeholder for each path, and the host supplies the paths.
use serde_json::Value;
use std::fmt;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub enum EngineManifestError {
    Read {
        manifest: PathBuf,
        source: std::io::Error,
    },
    Parse {
        manifest: PathBuf,
        source: serde_json::Error,
    },
    /// A path that is not UTF-8 cannot be written into the JSON table the Runtime reads.
    PathNotUtf8 {
        name: String,
        path: PathBuf,
    },
    /// The manifest names a path the host did not supply.
    UnknownPlaceholder {
        manifest: PathBuf,
        value: String,
    },
}

impl fmt::Display for EngineManifestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read { manifest, source } => {
                write!(formatter, "cannot read engine manifest {}: {source}", manifest.display())
            }
            Self::Parse { manifest, source } => {
                write!(formatter, "invalid engine manifest {}: {source}", manifest.display())
            }
            Self::PathNotUtf8 { name, path } => {
                write!(formatter, "engine path `{name}` is not UTF-8: {}", path.display())
            }
            Self::UnknownPlaceholder { manifest, value } => {
                write!(
                    formatter,
                    "engine manifest {} names a path the host did not supply: {value}",
                    manifest.display()
                )
            }
        }
    }
}

impl std::error::Error for EngineManifestError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Read { source, .. } => Some(source),
            Self::Parse { source, .. } => Some(source),
            Self::PathNotUtf8 { .. } | Self::UnknownPlaceholder { .. } => None,
        }
    }
}

/// Reads `manifest` and replaces every `${name}` in its strings with the path of that name.
pub fn engine_from_manifest(manifest: &Path, paths: &[(&str, &Path)]) -> Result<Value, EngineManifestError> {
    let source = std::fs::read_to_string(manifest)
        .map_err(|source| EngineManifestError::Read { manifest: manifest.to_owned(), source })?;
    let mut engine: Value = serde_json::from_str(&source)
        .map_err(|source| EngineManifestError::Parse { manifest: manifest.to_owned(), source })?;
    let mut replacements = Vec::with_capacity(paths.len());
    for (name, path) in paths {
        let text = path
            .to_str()
            .ok_or_else(|| EngineManifestError::PathNotUtf8 { name: (*name).to_owned(), path: (*path).to_owned() })?;
        replacements.push((format!("${{{name}}}"), text));
    }
    resolve(&mut engine, &replacements, manifest)?;
    Ok(engine)
}

fn resolve(value: &mut Value, replacements: &[(String, &str)], manifest: &Path) -> Result<(), EngineManifestError> {
    match value {
        Value::String(text) => {
            for (placeholder, path) in replacements {
                if text.contains(placeholder.as_str()) {
                    *text = text.replace(placeholder.as_str(), path);
                }
            }
            if text.contains("${") {
                return Err(EngineManifestError::UnknownPlaceholder {
                    manifest: manifest.to_owned(),
                    value: text.clone(),
                });
            }
        }
        Value::Array(items) => {
            for item in items {
                resolve(item, replacements, manifest)?;
            }
        }
        Value::Object(fields) => {
            for field in fields.values_mut() {
                resolve(field, replacements, manifest)?;
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest(contents: &str) -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("engine.json");
        std::fs::write(&path, contents).unwrap();
        (directory, path)
    }

    #[test]
    fn every_placeholder_becomes_the_supplied_path() {
        let (_directory, path) = manifest(
            r#"{"command": "${bun}", "args": ["--no-install", "${adapter}"], "env": {"CODEX_PATH": "${codex}", "CODEX_CONFIG": "{\"features\":{}}"}}"#,
        );
        // A Windows path keeps its backslashes: the paths are placed into parsed strings, not into JSON text.
        let engine = engine_from_manifest(
            &path,
            &[
                ("bun", Path::new(r"C:\Program Files\App\bun.exe")),
                ("adapter", Path::new("/app/adapter.mjs")),
                ("codex", Path::new("/app/codex")),
            ],
        )
        .unwrap();
        assert_eq!(
            engine,
            json!({
                "command": r"C:\Program Files\App\bun.exe",
                "args": ["--no-install", "/app/adapter.mjs"],
                "env": {"CODEX_PATH": "/app/codex", "CODEX_CONFIG": "{\"features\":{}}"}
            })
        );
    }

    #[test]
    fn a_path_the_host_did_not_supply_is_an_error() {
        let (_directory, path) = manifest(r#"{"command": "${bun}", "env": {"CODEX_PATH": "${codex}"}}"#);
        // Hosts hold owned paths; a reference to one is accepted as it is.
        let bun = PathBuf::from("/app/bun");
        let error = engine_from_manifest(&path, &[("bun", &bun)]).unwrap_err();
        assert!(
            matches!(error, EngineManifestError::UnknownPlaceholder { ref value, .. } if value == "${codex}"),
            "{error}"
        );
    }

    #[test]
    fn a_missing_or_malformed_manifest_is_an_error() {
        let (directory, path) = manifest("{");
        assert!(matches!(engine_from_manifest(&path, &[]).unwrap_err(), EngineManifestError::Parse { .. }));
        let missing = directory.path().join("missing.json");
        assert!(matches!(engine_from_manifest(&missing, &[]).unwrap_err(), EngineManifestError::Read { .. }));
    }
}
