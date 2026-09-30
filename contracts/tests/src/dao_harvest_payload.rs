use molecule::prelude::{Builder, Entity};
use proptest::prelude::*;
use serde::Deserialize;

use crate::{
    dao_harvest::{
        DAO_HARVEST_PAYLOAD_VERSION, ExecutorSetError, dao_harvest_payload_hash,
        decode_relative_epoch_duration, is_withdrawing_dao_data, maximum_withdraw_capacity,
        prepare_executor_set_hash,
    },
    dao_harvest_witness::{VaultOperation, parse_vault_operation},
    generated_dao_harvest::DaoHarvestPayloadV1,
};

#[derive(Deserialize)]
struct DaoHarvestFixture {
    version: u16,
    owner_lock_hash: String,
    payout_lock_hash: String,
    vault_lock_hash: String,
    dao_type_hash: String,
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
        .dao_type_hash(byte32(&fixture.dao_type_hash))
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
    assert_eq!(maximum_withdraw_capacity(1_000, 100, 100, 110), Some(1_090));
    assert_eq!(maximum_withdraw_capacity(100, 101, 100, 110), None);
    assert_eq!(maximum_withdraw_capacity(1_000, 100, 0, 110), None);
    assert_eq!(maximum_withdraw_capacity(1_000, 100, 110, 100), None);
    assert_eq!(
        decode_relative_epoch_duration((1 << 63) | (1 << 61) | 180),
        Some((180, 0, 0))
    );
    assert_eq!(decode_relative_epoch_duration((1 << 61) | 180), None);
}

#[test]
fn vault_witness_keeps_dao_input_type_available() {
    let mut prepare = vec![0, 0];
    prepare.extend_from_slice(&7_u32.to_le_bytes());
    assert_eq!(
        parse_vault_operation(&prepare),
        Some(VaultOperation::Prepare { job_input_index: 7 })
    );
    let mut roll = vec![0, 1];
    roll.extend_from_slice(&9_u32.to_le_bytes());
    assert_eq!(
        parse_vault_operation(&roll),
        Some(VaultOperation::Roll { job_input_index: 9 })
    );
    assert_eq!(
        parse_vault_operation(&[1, 3]),
        Some(VaultOperation::OwnerExit)
    );
    assert_eq!(parse_vault_operation(&[0, 0]), None);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]

    #[test]
    fn maximum_withdraw_never_reduces_valid_principal(
        principal in 1_u64..10_000_000_000_000,
        occupied_fraction in 0_u8..=100,
        deposit_rate in 1_u64..1_000_000_000,
        rate_gain in 0_u64..1_000_000_000,
    ) {
        let occupied = ((principal as u128 * occupied_fraction as u128) / 100) as u64;
        if let Some(withdrawing_rate) = deposit_rate.checked_add(rate_gain) {
            let maximum = maximum_withdraw_capacity(
                principal,
                occupied,
                deposit_rate,
                withdrawing_rate,
            ).expect("bounded fixture");
            prop_assert!(maximum >= principal);
        }
    }
}
