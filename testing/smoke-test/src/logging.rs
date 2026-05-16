//! Rotating structured log sink for the smoke-test harness.
//!
//! The harness logs its own lifecycle events and the stdout/stderr of the
//! subprocesses it spawns into a single file. The sink is intentionally small:
//! one primary log file plus one `.1` backup, with a default 10 MiB rollover.

use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Output;
use std::sync::{Arc, Mutex, OnceLock};

use chrono::{SecondsFormat, Utc};

const DEFAULT_LOG_FILE: &str = "artifacts/smoke-test/smoke-test.log";
const DEFAULT_MAX_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Debug => "DEBUG",
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
        }
    }
}

static LOGGER: OnceLock<Arc<RotatingLogger>> = OnceLock::new();

/// Log a single structured line.
pub fn log(level: Level, service: impl AsRef<str>, message: impl AsRef<str>) {
    let logger = global_logger();
    let service = service.as_ref();
    for line in message.as_ref().split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        logger.write_record(level, service, line);
    }
}

/// Convenience wrapper for debug-level messages.
pub fn debug(service: impl AsRef<str>, message: impl AsRef<str>) {
    log(Level::Debug, service, message);
}

/// Convenience wrapper for info-level messages.
pub fn info(service: impl AsRef<str>, message: impl AsRef<str>) {
    log(Level::Info, service, message);
}

/// Convenience wrapper for warn-level messages.
pub fn warn(service: impl AsRef<str>, message: impl AsRef<str>) {
    log(Level::Warn, service, message);
}

/// Convenience wrapper for error-level messages.
pub fn error(service: impl AsRef<str>, message: impl AsRef<str>) {
    log(Level::Error, service, message);
}

/// Log the captured stdout/stderr from a finished command.
pub fn log_command_output(service: impl AsRef<str>, output: &Output) {
    let service = service.as_ref();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        info(service, line);
    }
    for line in String::from_utf8_lossy(&output.stderr).lines() {
        error(service, line);
    }
}

/// Return the configured log path.
pub fn log_path() -> PathBuf {
    std::env::var_os("SMOKE_TEST_LOG_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_LOG_FILE))
}

/// Return the configured rollover threshold in bytes.
pub fn max_bytes() -> u64 {
    std::env::var("SMOKE_TEST_LOG_MAX_BYTES")
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_BYTES)
}

/// Force logger initialization.
pub fn init() -> Arc<RotatingLogger> {
    global_logger()
}

fn global_logger() -> Arc<RotatingLogger> {
    LOGGER
        .get_or_init(|| {
            Arc::new(
                RotatingLogger::new(log_path(), max_bytes())
                    .expect("initialize smoke-test rotating logger"),
            )
        })
        .clone()
}

#[derive(Debug)]
pub struct RotatingLogger {
    path: PathBuf,
    max_bytes: u64,
    state: Mutex<LogState>,
}

#[derive(Debug)]
struct LogState {
    file: Option<File>,
    bytes_written: u64,
}

impl RotatingLogger {
    pub fn new(path: PathBuf, max_bytes: u64) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        let file = Self::open_primary(&path)?;
        Ok(Self {
            path,
            max_bytes,
            state: Mutex::new(LogState {
                file: Some(file),
                bytes_written: 0,
            }),
        })
    }

    fn open_primary(path: &Path) -> io::Result<File> {
        OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(path)
    }

    fn backup_path(&self) -> PathBuf {
        let mut os: OsString = self.path.as_os_str().to_os_string();
        os.push(".1");
        PathBuf::from(os)
    }

    pub fn write_record(&self, level: Level, service: &str, message: &str) {
        let timestamp = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let record = format!("{timestamp} [{service}] [{}] {message}\n", level.as_str());
        let record_len = record.len() as u64;

        let mut state = self.state.lock().expect("smoke-test logger mutex");
        if state.bytes_written > 0 && state.bytes_written + record_len > self.max_bytes {
            self.rotate_locked(&mut state)
                .expect("rotate smoke-test log file");
        }

        let file = state.file.as_mut().expect("open smoke-test log file");
        file.write_all(record.as_bytes())
            .expect("write smoke-test log record");
        file.flush().expect("flush smoke-test log record");
        state.bytes_written += record_len;
    }

    fn rotate_locked(&self, state: &mut LogState) -> io::Result<()> {
        if let Some(file) = state.file.take() {
            file.sync_all()?;
            drop(file);
        }

        let backup = self.backup_path();
        if backup.exists() {
            fs::remove_file(&backup)?;
        }
        if self.path.exists() {
            fs::rename(&self.path, &backup)?;
        }

        let file = Self::open_primary(&self.path)?;
        state.file = Some(file);
        state.bytes_written = 0;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_primary_into_backup() {
        let dir = tempfile::tempdir().expect("tempdir");
        let log_path = dir.path().join("smoke-test.log");
        let logger = RotatingLogger::new(log_path.clone(), 256).expect("logger");

        for idx in 0..64 {
            logger.write_record(
                Level::Info,
                "geth",
                &format!("log line {idx:02} {}", "x".repeat(20)),
            );
        }

        let backup = PathBuf::from(format!("{}.1", log_path.display()));
        assert!(log_path.exists(), "primary log file missing");
        assert!(backup.exists(), "rotated backup missing");
        assert!(
            std::fs::metadata(&log_path)
                .expect("primary metadata")
                .len()
                > 0
        );
        assert!(std::fs::metadata(&backup).expect("backup metadata").len() > 0);
    }
}
