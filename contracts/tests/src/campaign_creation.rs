use ckb_testtool::{
    builtin::ALWAYS_SUCCESS,
    ckb_types::{
        bytes::Bytes,
        core::{Capacity, ScriptHashType, TransactionBuilder, TransactionView},
        packed::{CellOutput, WitnessArgs},
        prelude::*,
    },
    context::Context,
};
use molecule::prelude::{Builder, Entity};

use crate::{
    campaign::refund_commitment,
    campaign_identity::derive_campaign_id,
    fixtures::{contract_binary, create_cell, deployed_contract},
    generated_campaign::CampaignDataV1,
};

const MAX_CYCLES: u64 = 20_000_000;
const PLEDGED: u64 = 10_000_000_000;
const CHANGE: u64 = 10_000_000_000;
const FEE: u64 = 1_000_000;
const CREATION_TRANSACTION_HASH: &str =
    "0xa835e27cc69ef2f0d7e4d20eb3ce1b83de1925567e33ead535bd3bc0ffe08de9";

#[derive(Clone, Copy)]
enum Mutation {
    None,
    Version,
    State,
    CampaignId,
    CreationAnchor,
    Target,
    DeadlineZero,
    DeadlineMetric,
    PledgeCount,
    SuccessRecipient,
    RefundCommitment,
    RefundRecords,
    CapacityLow,
    CapacityHigh,
}

struct CreationCase {
    context: Context,
    transaction: TransactionView,
}

fn pledge_records() -> Vec<u8> {
    let mut records = Vec::with_capacity(152);
    for (transaction_seed, output_index, refund_seed, amount) in [
        (0x01, 0_u32, 0x51, 4_000_000_000_u64),
        (0x02, 1_u32, 0x52, 6_000_000_000_u64),
    ] {
        records.extend_from_slice(&[transaction_seed; 32]);
        records.extend_from_slice(&output_index.to_le_bytes());
        records.extend_from_slice(&[refund_seed; 32]);
        records.extend_from_slice(&amount.to_le_bytes());
    }
    records
}

fn build_creation_case(mutation: Mutation) -> CreationCase {
    let mut context = Context::new_with_deterministic_rng();
    let campaign_code = context.deploy_cell(contract_binary("demo-campaign-type"));
    let placeholder_campaign_type = context
        .build_script_with_hash_type(
            &campaign_code,
            ScriptHashType::Data1,
            Bytes::from(vec![0; 32]),
        )
        .expect("campaign type script");
    let campaign_lock = deployed_contract(&mut context, "campaign-lock");
    let funding_code = context.deploy_cell(ALWAYS_SUCCESS.clone());
    let funding_lock = context
        .build_script_with_hash_type(
            &funding_code,
            ScriptHashType::Data1,
            Bytes::from(vec![0x44; 20]),
        )
        .expect("funding lock");

    let records = pledge_records();
    let commitment = refund_commitment(2, &records);
    let placeholder_data = CampaignDataV1::new_builder()
        .version(1_u16.to_le_bytes())
        .state(0)
        .campaign_id([0; 32])
        .pledged(PLEDGED.to_le_bytes())
        .pledge_count(2_u32.to_le_bytes())
        .target(15_000_000_000_u64.to_le_bytes())
        .deadline_since(42_u64.to_le_bytes())
        .success_lock_hash([0x22; 32])
        .refund_commitment(commitment)
        .build()
        .as_bytes();
    let placeholder_output = CellOutput::new_builder()
        .lock(campaign_lock.clone())
        .type_(Some(placeholder_campaign_type).pack())
        .build();
    let occupied = placeholder_output
        .occupied_capacity(Capacity::bytes(placeholder_data.len()).expect("campaign data capacity"))
        .expect("campaign occupied capacity")
        .as_u64();
    let expected_capacity = occupied + PLEDGED;
    let funding_capacity = expected_capacity + CHANGE + FEE + 1;
    let empty_funding_output = CellOutput::new_builder().lock(funding_lock.clone()).build();
    let funding_minimum = empty_funding_output
        .occupied_capacity(Capacity::zero())
        .expect("funding occupied capacity")
        .as_u64();
    let funding = create_cell(
        &mut context,
        0x91,
        funding_lock.clone(),
        None,
        Bytes::new(),
        funding_capacity - funding_minimum,
    );
    let anchor_out_point: [u8; 36] = funding
        .input
        .previous_output()
        .as_slice()
        .try_into()
        .expect("funding outpoint");
    let derived_campaign_id = derive_campaign_id(&anchor_out_point, 0);
    let campaign_id = if matches!(mutation, Mutation::CreationAnchor) {
        [0x12; 32]
    } else {
        derived_campaign_id
    };
    let campaign_type = context
        .build_script_with_hash_type(
            &campaign_code,
            ScriptHashType::Data1,
            Bytes::copy_from_slice(&campaign_id),
        )
        .expect("campaign type script");

    let mut builder = CampaignDataV1::new_builder()
        .version(1_u16.to_le_bytes())
        .state(0)
        .campaign_id(campaign_id)
        .pledged(PLEDGED.to_le_bytes())
        .pledge_count(2_u32.to_le_bytes())
        .target(15_000_000_000_u64.to_le_bytes())
        .deadline_since(42_u64.to_le_bytes())
        .success_lock_hash([0x22; 32])
        .refund_commitment(commitment);
    builder = match mutation {
        Mutation::Version => builder.version(2_u16.to_le_bytes()),
        Mutation::State => builder.state(1),
        Mutation::CampaignId => builder.campaign_id([0x13; 32]),
        Mutation::Target => builder.target(0_u64.to_le_bytes()),
        Mutation::DeadlineZero => builder.deadline_since(0_u64.to_le_bytes()),
        Mutation::DeadlineMetric => builder.deadline_since(((1_u64 << 61) | 42).to_le_bytes()),
        Mutation::PledgeCount => builder.pledge_count(0_u32.to_le_bytes()),
        Mutation::SuccessRecipient => builder.success_lock_hash([0; 32]),
        Mutation::RefundCommitment => builder.refund_commitment([0; 32]),
        _ => builder,
    };
    let campaign_data = builder.build().as_bytes();

    let empty_campaign_output = CellOutput::new_builder()
        .lock(campaign_lock)
        .type_(Some(campaign_type).pack())
        .build();
    let actual_occupied = empty_campaign_output
        .occupied_capacity(Capacity::bytes(campaign_data.len()).expect("campaign data capacity"))
        .expect("campaign occupied capacity")
        .as_u64();
    assert_eq!(actual_occupied, occupied);
    let campaign_capacity = match mutation {
        Mutation::CapacityLow => expected_capacity - 1,
        Mutation::CapacityHigh => expected_capacity + 1,
        _ => expected_capacity,
    };
    let change_capacity = funding_capacity - campaign_capacity - FEE;

    let mut witness_records = records;
    if matches!(mutation, Mutation::RefundRecords) {
        let last = witness_records.last_mut().expect("pledge record");
        *last ^= 1;
    }
    let witness = WitnessArgs::new_builder()
        .output_type(Some(Bytes::from(witness_records)).pack())
        .build();

    let transaction = TransactionBuilder::default()
        .input(funding.input)
        .output(
            empty_campaign_output
                .as_builder()
                .capacity(campaign_capacity)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(change_capacity)
                .lock(funding_lock)
                .build(),
        )
        .output_data(campaign_data.pack())
        .output_data(Bytes::new().pack())
        .witness(witness.as_bytes().pack())
        .build();
    let transaction = context.complete_tx(transaction);
    CreationCase {
        context,
        transaction,
    }
}

fn verify(case: &CreationCase) -> Result<(), String> {
    case.context
        .verify_tx(&case.transaction, MAX_CYCLES)
        .map(|_| ())
        .map_err(|error| format!("{error:?}"))
}

fn assert_script_error(mutation: Mutation, code: i8) {
    let case = build_creation_case(mutation);
    let error = verify(&case).expect_err("malformed campaign creation must fail");
    assert!(
        error.contains(&code.to_string()),
        "unexpected error: {error}"
    );
}

#[test]
fn deterministic_campaign_fixture_can_be_created() {
    let first = build_creation_case(Mutation::None);
    let second = build_creation_case(Mutation::None);
    assert_eq!(
        first.transaction.data().as_slice(),
        second.transaction.data().as_slice()
    );
    assert_eq!(
        format!("{:#x}", first.transaction.hash()),
        CREATION_TRANSACTION_HASH
    );
    verify(&first).expect("valid campaign creation");
}

#[test]
fn campaign_creation_rejects_malformed_target_and_deadline() {
    assert_script_error(Mutation::Target, 10);
    assert_script_error(Mutation::DeadlineZero, 23);
    assert_script_error(Mutation::DeadlineMetric, 23);
}

#[test]
fn campaign_creation_rejects_incorrect_pledge_capacity() {
    assert_script_error(Mutation::CapacityLow, 28);
    assert_script_error(Mutation::CapacityHigh, 28);
    assert_script_error(Mutation::PledgeCount, 10);
}

#[test]
fn campaign_creation_binds_identity_state_and_recipients() {
    assert_script_error(Mutation::Version, 11);
    assert_script_error(Mutation::State, 13);
    assert_script_error(Mutation::CampaignId, 20);
    assert_script_error(Mutation::CreationAnchor, 20);
    assert_script_error(Mutation::SuccessRecipient, 10);
    assert_script_error(Mutation::RefundCommitment, 10);
    assert_script_error(Mutation::RefundRecords, 19);
}

pub(crate) fn benchmark_cases() -> Vec<crate::benchmarks::BenchmarkCase> {
    [
        ("campaign.create.valid", Mutation::None, None),
        (
            "campaign.create.invalid-refund-records",
            Mutation::RefundRecords,
            Some(19),
        ),
    ]
    .into_iter()
    .map(|(id, mutation, expected_error)| {
        let case = build_creation_case(mutation);
        crate::benchmarks::BenchmarkCase::new(id, case.context, case.transaction, expected_error)
    })
    .collect()
}
