#![no_std]
#![no_main]

use ckb_std::{default_alloc, entry, high_level::load_script};

entry!(main);
default_alloc!();

fn main() -> i8 {
    match load_script() {
        Ok(script) if script.args().raw_data().is_empty() => 0,
        _ => 10,
    }
}
