use molecule::prelude::{Builder, Entity};
use serde::Deserialize;

use crate::{
    dao_harvest::{
        DAO_HARVEST_PAYLOAD_VERSION, ExecutorSetError, dao_harvest_payload_hash,
        is_withdrawing_dao_data, prepare_executor_set_hash,
    },
    generated_dao_harvest::DaoHarvestPayloadV1,
};

#[derive(Deserialize)]
struct DaoHarvestFixture {
    version: u16,
    owner_lock_hash: String,
    payout_lock_hash: String,
    vault_lock_hash: String,
    principal_capacity: String,
    prepare_executor_lock_hashes: Vec<String>,
    prepare_executor_set_hash: String,
    executor_reward: String,
    min_compensation: String,
    prepare_buffer_epochs: String,
    confirmation_margin_epochs: String,
    total_cycles: u32,
    end_epoch_since: String,
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
fn rust_dao_harvest_payload_matches_cross_language_vectors() {
    let fixture: DaoHarvestFixture =
        serde_json::from_str(include_str!("../../fixtures/dao_harvest_payload_v1.json")).unwrap();
    assert_eq!(fixture.version, DAO_HARVEST_PAYLOAD_VERSION);
    let mut executors = fixture
        .prepare_executor_lock_hashes
        .iter()
        .map(|value| byte32(value))
        .collect::<Vec<_>>();
    assert_eq!(
        prepare_executor_set_hash(&mut executors),
        Ok(byte32(&fixture.prepare_executor_set_hash))
    );

    let encoded = DaoHarvestPayloadV1::new_builder()
        .version(fixture.version.to_le_bytes())
        .owner_lock_hash(byte32(&fixture.owner_lock_hash))
        .payout_lock_hash(byte32(&fixture.payout_lock_hash))
        .vault_lock_hash(byte32(&fixture.vault_lock_hash))
        .principal_capacity(
            fixture
                .principal_capacity
                .parse::<u64>()
                .unwrap()
                .to_le_bytes(),
        )
        .prepare_executor_set_hash(byte32(&fixture.prepare_executor_set_hash))
        .executor_reward(
            fixture
                .executor_reward
                .parse::<u64>()
                .unwrap()
                .to_le_bytes(),
        )
        .min_compensation(
            fixture
                .min_compensation
                .parse::<u64>()
                .unwrap()
                .to_le_bytes(),
        )
        .prepare_buffer_epochs(
            fixture
                .prepare_buffer_epochs
                .parse::<u64>()
                .unwrap()
                .to_le_bytes(),
        )
        .confirmation_margin_epochs(
            fixture
                .confirmation_margin_epochs
                .parse::<u64>()
                .unwrap()
                .to_le_bytes(),
        )
        .total_cycles(fixture.total_cycles.to_le_bytes())
        .end_epoch_since(
            fixture
                .end_epoch_since
                .parse::<u64>()
                .unwrap()
                .to_le_bytes(),
        )
        .build();

    assert_eq!(encoded.as_slice(), decode_hex(&fixture.expected_hex));
    assert_eq!(
        dao_harvest_payload_hash(&byte32(&fixture.policy_script_hash), encoded.as_slice()),
        Some(byte32(&fixture.expected_payload_hash))
    );
}

#[test]
fn executor_set_and_dao_state_boundaries_are_explicit() {
    let identity = [0x11_u8; 32];
    assert_eq!(
        prepare_executor_set_hash(&mut []),
        Err(ExecutorSetError::InvalidCount)
    );
    assert_eq!(
        prepare_executor_set_hash(&mut [identity, identity]),
        Err(ExecutorSetError::Duplicate)
    );
    assert_eq!(is_withdrawing_dao_data(&[0; 8]), Some(false));
    assert_eq!(
        is_withdrawing_dao_data(&[1, 0, 0, 0, 0, 0, 0, 0]),
        Some(true)
    );
    assert_eq!(is_withdrawing_dao_data(&[0; 7]), None);
}
