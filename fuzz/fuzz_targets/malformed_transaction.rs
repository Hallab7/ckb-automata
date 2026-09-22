#![no_main]

use ckb_types::packed::Transaction;
use libfuzzer_sys::fuzz_target;
use molecule::prelude::Entity;

fuzz_target!(|data: &[u8]| {
    if let Ok(transaction) = Transaction::from_slice(data) {
        let _ = transaction.as_slice().len();
        let _ = transaction.raw().outputs().len();
        let _ = transaction.witnesses().len();
    }
});
