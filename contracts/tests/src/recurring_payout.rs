use ckb_testtool::{
    builtin::ALWAYS_SUCCESS,
    ckb_types::{
        bytes::Bytes,
        core::{ScriptHashType, TransactionBuilder, TransactionView},
        packed::{CellInput, CellOutput, WitnessArgs},
        prelude::*,
    },
    context::Context,
};
use molecule::prelude::{Builder, Entity};
use proptest::prelude::*;

use crate::{
    fixtures::{
        deployed_contract, execution_witness, job_data, secp_wallet, sign_single_secp_input,
    },
    generated::JobDataV1,
    generated_recurring::RecurringPayloadV1,
    recurring::{absolute_block_trigger_hash, recurring_payload_hash},
};

const MAX_CYCLES: u64 = 30_000_000;
const JOB_CAPACITY: u64 = 200_000_000_000;
const EXECUTOR_CAPACITY: u64 = 100_000_000_000;
const REWARD: u64 = 10_000_000_000;
const PAYOUT: u64 = 20_000_000_000;
const FIRST_NOT_BEFORE: u64 = 500;
const INTERVAL: u64 = 100;
const MAX_ABSOLUTE_BLOCK: u64 = (1 << 56) - 1;
const FEE: u64 = 1_000_000;

#[derive(Clone, Copy)]
enum Mutation {
    None,
    WrongRecipient,
    WrongAmount,
    WrongAsset,
    Early,
    Duplicate,
    SkippedInterval,
    Overflow,
    ZeroInterval,
}

struct PayoutCase {
    context: Context,
    transaction: TransactionView,
}

fn build_case(mutation: Mutation) -> PayoutCase {
    build_case_with_executor_extra(mutation, 0)
}

fn build_case_with_executor_extra(mutation: Mutation, executor_extra: u64) -> PayoutCase {
    let mut context = Context::new_with_deterministic_rng();
    let job_lock = deployed_contract(&mut context, "job-lock");
    let recurring_policy = deployed_contract(&mut context, "recurring-policy");
    let executor = secp_wallet(&mut context, 31);
    let owner = secp_wallet(&mut context, 32);
    let recipient = secp_wallet(&mut context, 33);
    let executor_hash: [u8; 32] = executor.lock.calc_script_hash().unpack();
    let owner_hash: [u8; 32] = owner.lock.calc_script_hash().unpack();
    let recipient_hash: [u8; 32] = recipient.lock.calc_script_hash().unpack();
    let policy_hash: [u8; 32] = recurring_policy.calc_script_hash().unpack();
    let first_not_before = if matches!(mutation, Mutation::Overflow) {
        MAX_ABSOLUTE_BLOCK - 50
    } else {
        FIRST_NOT_BEFORE
    };
    let interval = if matches!(mutation, Mutation::ZeroInterval) {
        0
    } else {
        INTERVAL
    };

    let payload = RecurringPayloadV1::new_builder()
        .version(1_u16.to_le_bytes())
        .owner_lock_hash(owner_hash)
        .recipient_lock_hash(recipient_hash)
        .amount(PAYOUT.to_le_bytes())
        .interval_blocks(interval.to_le_bytes())
        .first_not_before(first_not_before.to_le_bytes())
        .total_runs(3_u32.to_le_bytes())
        .reward(REWARD.to_le_bytes())
        .final_refund_kind(0)
        .build()
        .as_bytes();
    let payload_hash = recurring_payload_hash(&policy_hash, &payload).expect("payload hash");

    let input_data = JobDataV1::from_slice(&job_data(
        owner_hash,
        policy_hash,
        REWARD,
        30_000_000_000,
        3,
    ))
    .expect("job data")
    .as_builder()
    .payload_hash(payload_hash)
    .trigger_params_hash(absolute_block_trigger_hash(first_not_before))
    .not_before(first_not_before.to_le_bytes())
    .build()
    .as_bytes();
    let successor_not_before = if matches!(mutation, Mutation::SkippedInterval) {
        first_not_before + INTERVAL * 2
    } else if matches!(mutation, Mutation::Overflow | Mutation::ZeroInterval) {
        first_not_before + 1
    } else {
        first_not_before + INTERVAL
    };
    let successor_data = JobDataV1::from_slice(&input_data)
        .expect("input job")
        .as_builder()
        .sequence(1_u64.to_le_bytes())
        .trigger_params_hash(absolute_block_trigger_hash(successor_not_before))
        .remaining_budget(20_000_000_000_u64.to_le_bytes())
        .not_before(successor_not_before.to_le_bytes())
        .remaining_runs(2_u32.to_le_bytes())
        .build()
        .as_bytes();

    let job_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(JOB_CAPACITY)
            .lock(job_lock.clone())
            .type_(Some(recurring_policy.clone()).pack())
            .build(),
        input_data,
    );
    let executor_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(EXECUTOR_CAPACITY + executor_extra)
            .lock(executor.lock.clone())
            .build(),
        Bytes::new(),
    );

    let payout_lock = if matches!(mutation, Mutation::WrongRecipient) {
        owner.lock.clone()
    } else {
        recipient.lock.clone()
    };
    let payout_capacity = if matches!(mutation, Mutation::WrongAmount) {
        PAYOUT + 1
    } else {
        PAYOUT
    };
    let asset_type = if matches!(mutation, Mutation::WrongAsset) {
        let code = context.deploy_cell(ALWAYS_SUCCESS.clone());
        Some(
            context
                .build_script_with_hash_type(&code, ScriptHashType::Data1, Bytes::new())
                .expect("asset type"),
        )
    } else {
        None
    };
    let duplicate = matches!(mutation, Mutation::Duplicate);
    let successor_capacity =
        JOB_CAPACITY - REWARD - payout_capacity - if duplicate { PAYOUT } else { 0 };
    let input_since = if matches!(mutation, Mutation::Early) {
        first_not_before - 1
    } else {
        first_not_before
    };

    let mut builder = TransactionBuilder::default()
        .input(
            CellInput::new_builder()
                .since(input_since)
                .previous_output(job_cell)
                .build(),
        )
        .input(
            CellInput::new_builder()
                .previous_output(executor_cell)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(REWARD)
                .lock(executor.lock.clone())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(payout_capacity)
                .lock(payout_lock)
                .type_(asset_type.pack())
                .build(),
        )
        .output_data(Bytes::new().pack())
        .output_data(Bytes::new().pack());
    if duplicate {
        builder = builder
            .output(
                CellOutput::new_builder()
                    .capacity(PAYOUT)
                    .lock(recipient.lock.clone())
                    .build(),
            )
            .output_data(Bytes::new().pack());
    }
    builder = builder
        .output(
            CellOutput::new_builder()
                .capacity(successor_capacity)
                .lock(job_lock)
                .type_(Some(recurring_policy).pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(EXECUTOR_CAPACITY + executor_extra - FEE)
                .lock(executor.lock)
                .build(),
        )
        .output_data(successor_data.pack())
        .output_data(Bytes::new().pack());
    let controlled_outputs: &[u32] = if duplicate { &[0, 1, 2, 3] } else { &[0, 1, 2] };
    let execution = execution_witness(0, 0, executor_hash, controlled_outputs)
        .as_builder()
        .output_type(Some(payload).pack())
        .build();
    let transaction = builder
        .witness(execution.as_bytes().pack())
        .witness(WitnessArgs::default().as_bytes().pack())
        .cell_dep(executor.data_dep)
        .build();
    let transaction = context.complete_tx(transaction);
    let transaction = sign_single_secp_input(transaction, 1, &executor.key);

    PayoutCase {
        context,
        transaction,
    }
}

fn verify(case: &PayoutCase) -> Result<(), String> {
    case.context
        .verify_tx(&case.transaction, MAX_CYCLES)
        .map(|_| ())
        .map_err(|error| format!("{error:?}"))
}

fn assert_fails(mutation: Mutation, code: i8) {
    let case = build_case(mutation);
    let error = verify(&case).expect_err("mutated recurring payout must fail");
    assert!(
        error.contains(&code.to_string()),
        "unexpected error: {error}"
    );
}

#[test]
fn recurring_policy_pays_the_exact_committed_native_amount() {
    verify(&build_case(Mutation::None)).expect("valid recurring payout");
}

#[test]
fn recurring_policy_rejects_payout_discretion_and_early_execution() {
    assert_fails(Mutation::WrongRecipient, 32);
    assert_fails(Mutation::WrongAmount, 32);
    assert_fails(Mutation::WrongAsset, 32);
    assert_fails(Mutation::Early, 23);
    assert_fails(Mutation::Duplicate, 32);
}

#[test]
fn recurring_policy_rejects_rewritten_or_invalid_next_triggers() {
    assert_fails(Mutation::SkippedInterval, 18);
    assert_fails(Mutation::Overflow, 34);
    assert_fails(Mutation::ZeroInterval, 10);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(16))]

    #[test]
    fn generated_valid_executor_funding_keeps_the_job_valid(executor_extra in 0_u64..1_000_000_000) {
        let case = build_case_with_executor_extra(Mutation::None, executor_extra);
        prop_assert!(verify(&case).is_ok());
    }

    #[test]
    fn generated_payout_mutation_classes_are_rejected(selector in 0_u8..3) {
        let mutation = match selector {
            0 => Mutation::WrongRecipient,
            1 => Mutation::WrongAmount,
            _ => Mutation::Duplicate,
        };
        let case = build_case(mutation);
        let error = verify(&case).expect_err("generated payout mutation must fail");
        prop_assert!(error.contains("32"), "unexpected error: {error}");
    }
}

pub(crate) fn benchmark_cases() -> Vec<crate::benchmarks::BenchmarkCase> {
    [
        ("recurring.payout-successor.valid", Mutation::None, None),
        (
            "recurring.payout-successor.invalid-duplicate",
            Mutation::Duplicate,
            Some(32),
        ),
    ]
    .into_iter()
    .map(|(id, mutation, expected_error)| {
        let case = build_case(mutation);
        crate::benchmarks::BenchmarkCase::new(id, case.context, case.transaction, expected_error)
    })
    .collect()
}
