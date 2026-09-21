use ckb_testtool::{
    builtin::ALWAYS_SUCCESS,
    ckb_types::{
        bytes::Bytes,
        core::{ScriptHashType, TransactionBuilder, TransactionView},
        packed::{CellInput, CellOutput, Script, WitnessArgs},
        prelude::*,
    },
    context::Context,
};
use molecule::prelude::{Builder, Entity};

use crate::fixtures::{
    deployed_contract, execution_witness, job_data, secp_wallet, sign_single_secp_input,
};
use crate::generated::JobDataV1;

const MAX_CYCLES: u64 = 20_000_000;
const JOB_CAPACITY: u64 = 200_000_000_000;
const EXECUTOR_CAPACITY: u64 = 20_000_000_000;
const REWARD: u64 = 10_000_000_000;
const APPLICATION_PAYOUT: u64 = 20_000_000_000;
const OWNER_REFUND: u64 = JOB_CAPACITY - REWARD - APPLICATION_PAYOUT;
const FEE: u64 = 1_000_000;
const LEAKAGE: u64 = 7_000_000_000;
const SUCCESSOR_CAPACITY: u64 = 50_000_000_000;

#[derive(Clone, Copy)]
enum Mutation {
    None,
    Policy,
    RewardAmount,
    RewardRecipient,
    ApplicationAmount,
    RefundAmount,
    FeeChange,
    Leakage,
    MissingControlledOutput,
    DuplicateControlledOutput,
    BudgetExceedsSpendable,
    RewardExceedsBudget,
    OneSuccessor,
    TwoSuccessors,
    ZeroRuns,
    Mode,
    Identity,
    SinceMismatch,
    UnsupportedVersion,
    InvalidState,
}

struct ExecutionCase {
    context: Context,
    other_lock: Script,
    transaction: TransactionView,
}

fn build_execution_case(mutation: Mutation) -> ExecutionCase {
    let mut context = Context::new_with_deterministic_rng();
    let job_lock = deployed_contract(&mut context, "job-lock");
    let executor = secp_wallet(&mut context, 3);
    let owner = secp_wallet(&mut context, 4);
    let recipient = secp_wallet(&mut context, 5);
    let secp_data_dep = executor.data_dep.clone();
    let executor_hash = executor.lock.calc_script_hash().unpack();
    let owner_hash = owner.lock.calc_script_hash().unpack();

    let policy_code = context.deploy_cell(ALWAYS_SUCCESS.clone());
    let policy = context
        .build_script_with_hash_type(
            &policy_code,
            ScriptHashType::Data1,
            Bytes::from(vec![0x55; 32]),
        )
        .expect("policy script");
    let actual_policy_hash = policy.calc_script_hash().unpack();
    let committed_policy_hash = if matches!(mutation, Mutation::Policy) {
        [0x99; 32]
    } else {
        actual_policy_hash
    };
    let remaining_budget = if matches!(mutation, Mutation::BudgetExceedsSpendable) {
        JOB_CAPACITY
    } else if matches!(mutation, Mutation::RewardExceedsBudget) {
        REWARD - 1
    } else {
        REWARD + APPLICATION_PAYOUT
    };
    let remaining_runs = if matches!(mutation, Mutation::ZeroRuns) {
        0
    } else {
        1
    };
    let mut canonical_job_data = job_data(
        owner_hash,
        committed_policy_hash,
        REWARD,
        remaining_budget,
        remaining_runs,
    );
    if matches!(
        mutation,
        Mutation::UnsupportedVersion | Mutation::InvalidState
    ) {
        let job = JobDataV1::from_slice(&canonical_job_data).expect("fixture job data");
        canonical_job_data = match mutation {
            Mutation::UnsupportedVersion => job.as_builder().version(2_u16.to_le_bytes()).build(),
            Mutation::InvalidState => job.as_builder().state(1).build(),
            _ => unreachable!("guarded mutation"),
        }
        .as_bytes();
    }
    let job_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(JOB_CAPACITY)
            .lock(job_lock.clone())
            .type_(Some(policy.clone()).pack())
            .build(),
        canonical_job_data.clone(),
    );
    let executor_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(EXECUTOR_CAPACITY)
            .lock(executor.lock.clone())
            .build(),
        Bytes::new(),
    );

    let reward_capacity = if matches!(mutation, Mutation::RewardAmount) {
        REWARD - 1
    } else {
        REWARD
    };
    let application_capacity = if matches!(mutation, Mutation::ApplicationAmount) {
        APPLICATION_PAYOUT - 1
    } else {
        APPLICATION_PAYOUT
    };
    let successor_count = if matches!(mutation, Mutation::OneSuccessor) {
        1
    } else if matches!(mutation, Mutation::TwoSuccessors) {
        2
    } else {
        0
    };
    let refund_capacity = if matches!(mutation, Mutation::RefundAmount) {
        OWNER_REFUND - 1
    } else if matches!(mutation, Mutation::Leakage) {
        OWNER_REFUND - LEAKAGE
    } else {
        OWNER_REFUND - SUCCESSOR_CAPACITY * successor_count
    };
    let fee_change_capacity = if matches!(mutation, Mutation::FeeChange) {
        EXECUTOR_CAPACITY - FEE - 1
    } else {
        EXECUTOR_CAPACITY - FEE
    };
    let reward_lock = if matches!(mutation, Mutation::RewardRecipient | Mutation::Identity) {
        owner.lock.clone()
    } else {
        executor.lock.clone()
    };
    let committed_executor = if matches!(mutation, Mutation::Identity) {
        owner_hash
    } else {
        executor_hash
    };
    let mode = if matches!(mutation, Mutation::Mode) {
        4
    } else {
        0
    };
    let controlled_outputs: &[u32] = if matches!(mutation, Mutation::MissingControlledOutput) {
        &[0, 1]
    } else if matches!(mutation, Mutation::DuplicateControlledOutput) {
        &[0, 1, 1, 2]
    } else if successor_count == 1 {
        &[0, 1, 2, 4]
    } else if successor_count == 2 {
        &[0, 1, 2, 4, 5]
    } else {
        &[0, 1, 2]
    };

    let job_since = if matches!(mutation, Mutation::SinceMismatch) {
        1
    } else {
        0
    };
    let mut builder = TransactionBuilder::default()
        .input(
            CellInput::new_builder()
                .since(job_since)
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
                .capacity(reward_capacity)
                .lock(reward_lock)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(application_capacity)
                .lock(recipient.lock)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(refund_capacity)
                .lock(owner.lock.clone())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(fee_change_capacity)
                .lock(executor.lock)
                .build(),
        )
        .output_data(Bytes::new().pack())
        .output_data(Bytes::new().pack())
        .output_data(Bytes::new().pack())
        .output_data(Bytes::new().pack());
    if matches!(mutation, Mutation::Leakage) {
        builder = builder
            .output(
                CellOutput::new_builder()
                    .capacity(LEAKAGE)
                    .lock(owner.lock.clone())
                    .build(),
            )
            .output_data(Bytes::new().pack());
    }
    for _ in 0..successor_count {
        builder = builder
            .output(
                CellOutput::new_builder()
                    .capacity(SUCCESSOR_CAPACITY)
                    .lock(job_lock.clone())
                    .type_(Some(policy.clone()).pack())
                    .build(),
            )
            .output_data(canonical_job_data.clone().pack());
    }
    let transaction = builder
        .witness(
            execution_witness(mode, 0, committed_executor, controlled_outputs)
                .as_bytes()
                .pack(),
        )
        .witness(WitnessArgs::default().as_bytes().pack())
        .cell_dep(secp_data_dep)
        .build();
    let transaction = context.complete_tx(transaction);
    let transaction = sign_single_secp_input(transaction, 1, &executor.key);
    ExecutionCase {
        context,
        other_lock: owner.lock,
        transaction,
    }
}

fn verify(execution: &ExecutionCase) -> Result<(), String> {
    execution
        .context
        .verify_tx(&execution.transaction, MAX_CYCLES)
        .map(|_| ())
        .map_err(|error| format!("{error:?}"))
}

fn assert_script_error(mutation: Mutation, code: i8) {
    let execution = build_execution_case(mutation);
    let error = verify(&execution).expect_err("mutated execution must fail");
    assert!(
        error.contains(&code.to_string()),
        "unexpected error: {error}"
    );
}

#[test]
fn permissionless_execution_binds_policy_identity_and_reward() {
    let execution = build_execution_case(Mutation::None);
    verify(&execution).expect("valid permissionless execution");
}

#[test]
fn changed_policy_fails() {
    assert_script_error(Mutation::Policy, 17);
}

#[test]
fn changed_reward_amount_fails() {
    assert_script_error(Mutation::RewardAmount, 29);
}

#[test]
fn changed_reward_recipient_fails() {
    assert_script_error(Mutation::RewardRecipient, 30);
}

#[test]
fn changed_mode_fails() {
    assert_script_error(Mutation::Mode, 15);
}

#[test]
fn changed_executor_identity_fails() {
    assert_script_error(Mutation::Identity, 30);
}

#[test]
fn input_since_must_match_the_committed_lower_bound() {
    assert_script_error(Mutation::SinceMismatch, 23);
}

#[test]
fn normal_execution_rejects_recovery_only_job_metadata() {
    assert_script_error(Mutation::UnsupportedVersion, 11);
    assert_script_error(Mutation::InvalidState, 13);
}

#[test]
fn every_job_controlled_capacity_is_conserved() {
    assert_script_error(Mutation::ApplicationAmount, 28);
    assert_script_error(Mutation::RefundAmount, 28);
    assert_script_error(Mutation::MissingControlledOutput, 28);
    assert_script_error(Mutation::DuplicateControlledOutput, 15);
}

#[test]
fn budget_must_fit_spendable_capacity_and_cover_reward() {
    assert_script_error(Mutation::BudgetExceedsSpendable, 28);
    assert_script_error(Mutation::RewardExceedsBudget, 28);
}

#[test]
fn one_shot_accepts_zero_successors() {
    let execution = build_execution_case(Mutation::None);
    verify(&execution).expect("terminal execution without successor");
}

#[test]
fn one_shot_rejects_one_or_multiple_successors() {
    assert_script_error(Mutation::OneSuccessor, 24);
    assert_script_error(Mutation::TwoSuccessors, 24);
}

#[test]
fn zero_remaining_runs_is_invalid() {
    assert_script_error(Mutation::ZeroRuns, 10);
}

#[test]
fn uncommitted_output_cannot_receive_job_value() {
    assert_script_error(Mutation::Leakage, 28);
}

#[test]
fn executor_fee_change_is_separate_from_job_value() {
    let execution = build_execution_case(Mutation::FeeChange);
    verify(&execution).expect("executor may pay an additional fee from its own input");
}

#[test]
fn copied_transaction_cannot_redirect_reward() {
    let mut execution = build_execution_case(Mutation::None);
    let mut outputs: Vec<_> = execution.transaction.outputs().into_iter().collect();
    outputs[0] = outputs[0]
        .clone()
        .as_builder()
        .lock(execution.other_lock.clone())
        .build();
    execution.transaction = execution
        .transaction
        .as_advanced_builder()
        .set_outputs(outputs)
        .build();
    verify(&execution).expect_err("redirected copied transaction must fail");
}
