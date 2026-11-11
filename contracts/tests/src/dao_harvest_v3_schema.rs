use molecule::prelude::{Builder, Entity};

use crate::{
    dao_harvest_v2,
    dao_harvest_v3::{
        DAO_HARVEST_V3_VERSION, OWNER_EXIT_OPERATION, OWNER_RECOVERY_OPERATION, payload_hash,
        progress_hash,
    },
    generated_dao_harvest_v3::{DaoHarvestPayloadV3, DaoHarvestProgressV3},
};

fn payload() -> DaoHarvestPayloadV3 {
    DaoHarvestPayloadV3::new_builder()
        .version(DAO_HARVEST_V3_VERSION.to_le_bytes())
        .owner_lock_hash([0x11; 32])
        .payout_lock_hash([0x22; 32])
        .vault_lock_code_hash([0x33; 32])
        .compensation_lock_code_hash([0x44; 32])
        .dao_type_hash([0x55; 32])
        .principal_capacity(10_000_u64.to_le_bytes())
        .preferred_prepare_operator_lock_hash([0x66; 32])
        .fallback_prepare_executor_set_hash([0x77; 32])
        .prepare_service_fee(2_u64.to_le_bytes())
        .claim_service_fee(3_u64.to_le_bytes())
        .compensation_seed_capacity(201_u64.to_le_bytes())
        .prepare_buffer_epochs(((1_u64 << 63) | (1 << 61) | 4).to_le_bytes())
        .takeover_delay_epochs(((1_u64 << 63) | (1 << 61) | 1).to_le_bytes())
        .confirmation_margin_epochs(((1_u64 << 63) | (1 << 61) | 1).to_le_bytes())
        .total_cycles(2_u32.to_le_bytes())
        .end_epoch_since(((1_u64 << 61) | 1_000).to_le_bytes())
        .build()
}

#[test]
fn v3_hash_domains_are_distinct_from_v2() {
    let payload = payload();
    let policy = [0xaa; 32];
    assert_ne!(
        payload_hash(&policy, payload.as_slice()),
        dao_harvest_v2::payload_hash(&policy, payload.as_slice())
    );

    let progress = DaoHarvestProgressV3::new_builder()
        .version(DAO_HARVEST_V3_VERSION.to_le_bytes())
        .state(0)
        .cycle_index(0_u32.to_le_bytes())
        .prepare_credit_hash([0_u8; 32])
        .build();
    assert_ne!(
        progress_hash(progress.as_slice()),
        dao_harvest_v2::progress_hash(progress.as_slice())
    );
}

#[test]
fn owner_operations_have_distinct_closed_codes() {
    assert_eq!(OWNER_EXIT_OPERATION, 9);
    assert_eq!(OWNER_RECOVERY_OPERATION, 10);
    assert_ne!(OWNER_EXIT_OPERATION, OWNER_RECOVERY_OPERATION);
    assert!(crate::dao_harvest_v3::operation_is_supported(
        OWNER_RECOVERY_OPERATION
    ));
    assert!(!crate::dao_harvest_v3::operation_is_supported(11));
}
