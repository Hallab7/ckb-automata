use molecule::prelude::{Builder, Entity};
use serde::Deserialize;

use crate::{
    generated_recurring::RecurringPayloadV1,
    recurring::{
        absolute_block_trigger_hash, recurring_payload_hash, scheduled_block_lower_bound,
        valid_recurring_schedule,
    },
};

#[derive(Deserialize)]
struct RecurringFixture {
    version: u16,
    owner_lock_hash: String,
    recipient_lock_hash: String,
    amount: String,
    interval_blocks: String,
    first_not_before: String,
    total_runs: u32,
    reward: String,
    final_refund_kind: u8,
    policy_script_hash: String,
    expected_hex: String,
    expected_payload_hash: String,
}

fn decode_hex(value: &str) -> Vec<u8> {
    let digits = value.strip_prefix("0x").unwrap_or(value);
    assert_eq!(digits.len() % 2, 0, "hex value has an odd length");
    (0..digits.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&digits[index..index + 2], 16).unwrap())
        .collect()
}

fn byte32(value: &str) -> [u8; 32] {
    decode_hex(value)
        .try_into()
        .expect("fixture must contain 32 bytes")
}

#[test]
fn rust_recurring_payload_matches_cross_language_vectors() {
    let fixture: RecurringFixture =
        serde_json::from_str(include_str!("../../fixtures/recurring_payload_v1.json")).unwrap();
    let encoded = RecurringPayloadV1::new_builder()
        .version(fixture.version.to_le_bytes())
        .owner_lock_hash(byte32(&fixture.owner_lock_hash))
        .recipient_lock_hash(byte32(&fixture.recipient_lock_hash))
        .amount(fixture.amount.parse::<u64>().unwrap().to_le_bytes())
        .interval_blocks(
            fixture
                .interval_blocks
                .parse::<u64>()
                .unwrap()
                .to_le_bytes(),
        )
        .first_not_before(
            fixture
                .first_not_before
                .parse::<u64>()
                .unwrap()
                .to_le_bytes(),
        )
        .total_runs(fixture.total_runs.to_le_bytes())
        .reward(fixture.reward.parse::<u64>().unwrap().to_le_bytes())
        .final_refund_kind(fixture.final_refund_kind)
        .build();

    assert_eq!(encoded.as_slice(), decode_hex(&fixture.expected_hex));
    assert_eq!(
        recurring_payload_hash(&byte32(&fixture.policy_script_hash), encoded.as_slice()),
        Some(byte32(&fixture.expected_payload_hash))
    );
}

#[test]
fn recurring_schedule_rejects_invalid_boundaries() {
    assert!(valid_recurring_schedule(1, 1, 1, 1, 0));
    assert!(!valid_recurring_schedule(0, 1, 1, 1, 0));
    assert!(!valid_recurring_schedule(1, 0, 1, 1, 0));
    assert!(!valid_recurring_schedule(1, 1, 0, 1, 0));
    assert!(!valid_recurring_schedule(1, 1, 1 << 56, 1, 0));
    assert!(!valid_recurring_schedule(1, 1, 1, 0, 0));
    assert!(!valid_recurring_schedule(1, 1, 1, 1, 1));
}

#[test]
fn next_lower_bound_ignores_late_execution_height() {
    assert_eq!(scheduled_block_lower_bound(500, 0, 100), Some(500));
    assert_eq!(scheduled_block_lower_bound(500, 1, 100), Some(600));
    assert_eq!(scheduled_block_lower_bound(500, 2, 100), Some(700));
    assert_eq!(scheduled_block_lower_bound(500, 1, 0), None);
    assert_eq!(scheduled_block_lower_bound((1 << 56) - 50, 1, 100), None);
    assert_ne!(
        absolute_block_trigger_hash(500),
        absolute_block_trigger_hash(600)
    );
}
