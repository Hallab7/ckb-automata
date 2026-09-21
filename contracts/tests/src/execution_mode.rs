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

use crate::fixtures::{deployed_contract, job_data, secp_wallet, sign_single_secp_input};

const MAX_CYCLES: u64 = 20_000_000;
const JOB_CAPACITY: u64 = 30_000_000_000;
const EXECUTOR_CAPACITY: u64 = 20_000_000_000;
const REWARD: u64 = 10_000_000_000;
const FEE: u64 = 1_000_000;

#[derive(Clone, Copy)]
enum Mutation {
    None,
    Policy,
    RewardAmount,
    RewardRecipient,
    Mode,
    Identity,
}

struct ExecutionCase {
    context: Context,
    other_lock: Script,
    transaction: TransactionView,
}

fn execution_witness(mode: u8, reward_output_index: u32, executor_hash: [u8; 32]) -> WitnessArgs {
    let mut request = Vec::with_capacity(37);
    request.push(mode);
    request.extend_from_slice(&reward_output_index.to_le_bytes());
    request.extend_from_slice(&executor_hash);
    WitnessArgs::new_builder()
        .input_type(Some(Bytes::from(request)).pack())
        .build()
}

fn build_execution_case(mutation: Mutation) -> ExecutionCase {
    let mut context = Context::new_with_deterministic_rng();
    let job_lock = deployed_contract(&mut context, "job-lock");
    let executor = secp_wallet(&mut context, 3);
    let other = secp_wallet(&mut context, 4);
    let secp_data_dep = executor.data_dep.clone();
    let executor_hash = executor.lock.calc_script_hash().unpack();
    let other_hash = other.lock.calc_script_hash().unpack();

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
    let job_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(JOB_CAPACITY)
            .lock(job_lock)
            .type_(Some(policy).pack())
            .build(),
        job_data([0xaa; 32], committed_policy_hash, REWARD, REWARD, 1),
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
    let reward_lock = if matches!(mutation, Mutation::RewardRecipient | Mutation::Identity) {
        other.lock.clone()
    } else {
        executor.lock.clone()
    };
    let committed_executor = if matches!(mutation, Mutation::Identity) {
        other_hash
    } else {
        executor_hash
    };
    let mode = if matches!(mutation, Mutation::Mode) {
        3
    } else {
        0
    };

    let transaction = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(job_cell).build())
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
                .capacity(EXECUTOR_CAPACITY - FEE)
                .lock(executor.lock)
                .build(),
        )
        .output_data(Bytes::new().pack())
        .output_data(Bytes::new().pack())
        .witness(
            execution_witness(mode, 0, committed_executor)
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
        other_lock: other.lock,
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
