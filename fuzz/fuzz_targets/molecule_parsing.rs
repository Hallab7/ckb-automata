#![no_main]

use libfuzzer_sys::fuzz_target;
use molecule::prelude::Entity;

#[allow(
    dead_code,
    clippy::clone_on_copy,
    clippy::derivable_impls,
    clippy::if_same_then_else,
    clippy::manual_is_multiple_of,
    clippy::needless_borrow,
    clippy::write_literal
)]
mod job_generated {
    include!("../../contracts/generated/job_v1.rs");
}

#[allow(
    dead_code,
    clippy::clone_on_copy,
    clippy::derivable_impls,
    clippy::if_same_then_else,
    clippy::manual_is_multiple_of,
    clippy::needless_borrow,
    clippy::write_literal
)]
mod campaign_generated {
    include!("../../contracts/generated/campaign_v1.rs");
}

#[allow(
    dead_code,
    clippy::clone_on_copy,
    clippy::derivable_impls,
    clippy::if_same_then_else,
    clippy::manual_is_multiple_of,
    clippy::needless_borrow,
    clippy::write_literal
)]
mod recurring_generated {
    include!("../../contracts/generated/recurring_v1.rs");
}

fuzz_target!(|data: &[u8]| {
    let _ = job_generated::JobDataV1::from_slice(data);
    let _ = campaign_generated::CampaignDataV1::from_slice(data);
    let _ = recurring_generated::RecurringPayloadV1::from_slice(data);
});
