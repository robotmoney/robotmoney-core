//! `rust-payment-daemon` library crate.
//!
//! Re-exports the modules used by the `rmpd` binary so integration tests
//! (and, later, embedders) can build against the same types. The binary
//! entry point lives in `src/main.rs`.

#![allow(dead_code)]

pub mod cli;
pub mod commands;
pub mod config;
pub mod errors;
pub mod fees;
pub mod gateway;
pub mod nonce;
pub mod policy;
pub mod rpc;
pub mod signer;
pub mod tx;
