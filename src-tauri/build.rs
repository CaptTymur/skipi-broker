use std::{env, process::Command};

fn build_sha() -> String {
    if let Ok(sha) = env::var("SKIPI_BUILD_SHA").or_else(|_| env::var("GITHUB_SHA")) {
        let sha = sha.trim();
        if !sha.is_empty() {
            return sha.chars().take(12).collect();
        }
    }

    if let Ok(out) = Command::new("git")
        .args(["rev-parse", "--short=12", "HEAD"])
        .output()
    {
        if out.status.success() {
            let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !sha.is_empty() {
                return sha;
            }
        }
    }

    "unknown".to_string()
}

fn main() {
    println!("cargo:rerun-if-env-changed=SKIPI_BUILD_SHA");
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rustc-env=SKIPI_BUILD_SHA={}", build_sha());
    tauri_build::build()
}
