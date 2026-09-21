use ckb_testtool::{
    ckb_types::{
        bytes::Bytes,
        core::{TransactionBuilder, TransactionView},
        packed::{CellInput, CellOutput, WitnessArgs},
        prelude::*,
    },
    context::Context,
};
use molecule::prelude::{Builder, Entity};

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
const RESIDUAL: u64 = JOB_CAPACITY - REWARD - PAYOUT;
const FIRST_NOT_BEFORE: u64 = 500;
const INTERVAL: u64 = 100;
const FEE: u64 = 1_000_000;

#[derive(Clone, Copy)]
enum Mutation {
    None,
    EarlyTermination,
    SuccessorAfterFinal,
    ResidualLow,
    ResidualHigh,
    RedirectResidual,
    MissingPayout,
}

struct FinalCase {
    context: Context,
    transaction: TransactionView,
}

fn build_case(mutation: Mutation) -> FinalCase {
    let mut context = Context::new_with_deterministic_rng();
    let job_lock = deployed_contract(&mut context, "job-lock");
    let recurring_policy = deployed_contract(&mut context, "recurring-policy");
    let executor = secp_wallet(&mut context, 41);
    let owner = secp_wallet(&mut context, 42);
    let recipient = secp_wallet(&mut context, 43);
    let executor_hash: [u8; 32] = executor.lock.calc_script_hash().unpack();
    let owner_hash: [u8; 32] = owner.lock.calc_script_hash().unpack();
    let recipient_hash: [u8; 32] = recipient.lock.calc_script_hash().unpack();
    let policy_hash: [u8; 32] = recurring_policy.calc_script_hash().unpack();

    let payload = RecurringPayloadV1::new_builder()
        .version(1_u16.to_le_bytes())
        .owner_lock_hash(owner_hash)
        .recipient_lock_hash(recipient_hash)
        .amount(PAYOUT.to_le_bytes())
        .interval_blocks(INTERVAL.to_le_bytes())
        .first_not_before(FIRST_NOT_BEFORE.to_le_bytes())
        .total_runs(3_u32.to_le_bytes())
        .reward(REWARD.to_le_bytes())
        .final_refund_kind(0)
        .build()
        .as_bytes();
    let payload_hash = recurring_payload_hash(&policy_hash, &payload).expect("payload hash");
    let early = matches!(mutation, Mutation::EarlyTermination);
    let sequence = if early { 1_u64 } else { 2_u64 };
    let remaining_runs = if early { 2_u32 } else { 1_u32 };
    let not_before = FIRST_NOT_BEFORE + sequence * INTERVAL;
    let input_data = JobDataV1::from_slice(&job_data(
        owner_hash,
        policy_hash,
        REWARD,
        REWARD,
        remaining_runs,
    ))
    .expect("job data")
    .as_builder()
    .sequence(sequence.to_le_bytes())
    .trigger_params_hash(absolute_block_trigger_hash(not_before))
    .payload_hash(payload_hash)
    .not_before(not_before.to_le_bytes())
    .build()
    .as_bytes();
    let job_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(JOB_CAPACITY)
            .lock(job_lock.clone())
            .type_(Some(recurring_policy.clone()).pack())
            .build(),
        input_data.clone(),
    );
    let executor_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(EXECUTOR_CAPACITY)
            .lock(executor.lock.clone())
            .build(),
        Bytes::new(),
    );

    let residual_delta = if matches!(mutation, Mutation::ResidualLow) {
        -1_i64
    } else if matches!(mutation, Mutation::ResidualHigh) {
        1_i64
    } else {
        0
    };
    let residual_capacity = RESIDUAL.checked_add_signed(residual_delta).unwrap();
    let executor_change = (EXECUTOR_CAPACITY - FEE)
        .checked_add_signed(-residual_delta)
        .unwrap();
    let payout_lock = if matches!(mutation, Mutation::MissingPayout) {
        owner.lock.clone()
    } else {
        recipient.lock.clone()
    };
    let residual_lock = if matches!(mutation, Mutation::RedirectResidual) {
        recipient.lock.clone()
    } else {
        owner.lock.clone()
    };
    let successor = matches!(mutation, Mutation::SuccessorAfterFinal);
    let terminal_output = if successor {
        CellOutput::new_builder()
            .capacity(residual_capacity)
            .lock(job_lock)
            .type_(Some(recurring_policy).pack())
            .build()
    } else {
        CellOutput::new_builder()
            .capacity(residual_capacity)
            .lock(residual_lock)
            .build()
    };
    let terminal_data = if successor {
        JobDataV1::from_slice(&input_data)
            .expect("final input data")
            .as_builder()
            .sequence((sequence + 1).to_le_bytes())
            .remaining_runs(0_u32.to_le_bytes())
            .build()
            .as_bytes()
    } else {
        Bytes::new()
    };

    let execution = execution_witness(0, 0, executor_hash, &[0, 1, 2])
        .as_builder()
        .output_type(Some(payload).pack())
        .build();
    let transaction = TransactionBuilder::default()
        .input(
            CellInput::new_builder()
                .since(not_before)
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
                .capacity(PAYOUT)
                .lock(payout_lock)
                .build(),
        )
        .output(terminal_output)
        .output(
            CellOutput::new_builder()
                .capacity(executor_change)
                .lock(executor.lock)
                .build(),
        )
        .output_data(Bytes::new().pack())
        .output_data(Bytes::new().pack())
        .output_data(terminal_data.pack())
        .output_data(Bytes::new().pack())
        .witness(execution.as_bytes().pack())
        .witness(WitnessArgs::default().as_bytes().pack())
        .cell_dep(executor.data_dep)
        .build();
    let transaction = context.complete_tx(transaction);
    let transaction = sign_single_secp_input(transaction, 1, &executor.key);
    FinalCase {
        context,
        transaction,
    }
}

fn verify(case: &FinalCase) -> Result<(), String> {
    case.context
        .verify_tx(&case.transaction, MAX_CYCLES)
        .map(|_| ())
        .map_err(|error| format!("{error:?}"))
}

fn assert_fails(mutation: Mutation, code: i8) {
    let case = build_case(mutation);
    let error = verify(&case).expect_err("mutated final run must fail");
    assert!(
        error.contains(&code.to_string()),
        "unexpected error: {error}"
    );
}

#[test]
fn final_run_pays_once_and_returns_all_residual_capacity() {
    verify(&build_case(Mutation::None)).expect("valid final recurring run");
}

#[test]
fn recurring_schedule_executes_exactly_the_committed_run_count() {
    assert_fails(Mutation::EarlyTermination, 24);
    assert_fails(Mutation::SuccessorAfterFinal, 24);
}

#[test]
fn final_run_rejects_residual_and_payout_mutations() {
    assert_fails(Mutation::ResidualLow, 28);
    assert_fails(Mutation::ResidualHigh, 28);
    assert_fails(Mutation::RedirectResidual, 32);
    assert_fails(Mutation::MissingPayout, 32);
}
