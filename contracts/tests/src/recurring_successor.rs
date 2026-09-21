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

use crate::{
    fixtures::{
        deployed_contract, execution_witness, job_data, secp_wallet, sign_single_secp_input,
    },
    generated::JobDataV1,
};

const MAX_CYCLES: u64 = 20_000_000;
const JOB_CAPACITY: u64 = 200_000_000_000;
const EXECUTOR_CAPACITY: u64 = 100_000_000_000;
const REWARD: u64 = 10_000_000_000;
const PAYOUT: u64 = 20_000_000_000;
const SUCCESSOR_CAPACITY: u64 = JOB_CAPACITY - REWARD - PAYOUT;
const FEE: u64 = 1_000_000;

#[derive(Clone, Copy)]
enum Mutation {
    None,
    Missing,
    Multiple,
    Uncontrolled,
    Version,
    Flags,
    JobId,
    State,
    TriggerKind,
    PolicyData,
    PolicyType,
    Payload,
    Reward,
    NotAfter,
    Owner,
    Sequence,
    SequenceOverflow,
    Runs,
    RunsIncrease,
    Budget,
    BudgetIncrease,
    Trigger,
}

struct RecurringCase {
    context: Context,
    transaction: TransactionView,
}

fn build_recurring_case(mutation: Mutation) -> RecurringCase {
    let mut context = Context::new_with_deterministic_rng();
    let job_lock = deployed_contract(&mut context, "job-lock");
    let executor = secp_wallet(&mut context, 6);
    let owner = secp_wallet(&mut context, 7);
    let recipient = secp_wallet(&mut context, 8);
    let secp_data_dep = executor.data_dep.clone();
    let executor_hash = executor.lock.calc_script_hash().unpack();
    let owner_hash = owner.lock.calc_script_hash().unpack();

    let policy_code = context.deploy_cell(ALWAYS_SUCCESS.clone());
    let policy = context
        .build_script_with_hash_type(
            &policy_code,
            ScriptHashType::Data1,
            Bytes::from(vec![0x61; 32]),
        )
        .expect("policy script");
    let other_policy = context
        .build_script_with_hash_type(
            &policy_code,
            ScriptHashType::Data1,
            Bytes::from(vec![0x62; 32]),
        )
        .expect("other policy script");
    let policy_hash = policy.calc_script_hash().unpack();
    let mut input_data = job_data(owner_hash, policy_hash, REWARD, 30_000_000_000, 3);
    if matches!(mutation, Mutation::SequenceOverflow) {
        input_data = JobDataV1::from_slice(&input_data)
            .expect("fixture job data")
            .as_builder()
            .sequence(u64::MAX.to_le_bytes())
            .build()
            .as_bytes();
    }
    let input_job = JobDataV1::from_slice(&input_data).expect("fixture job data");
    let mut successor_builder = input_job
        .as_builder()
        .sequence(1_u64.to_le_bytes())
        .remaining_runs(2_u32.to_le_bytes())
        .remaining_budget(20_000_000_000_u64.to_le_bytes())
        .trigger_params_hash([0x23; 32])
        .not_before(1_u64.to_le_bytes());
    successor_builder = match mutation {
        Mutation::Version => successor_builder.version(2_u16.to_le_bytes()),
        Mutation::Flags => successor_builder.flags(1_u16.to_le_bytes()),
        Mutation::JobId => successor_builder.job_id([0x91; 32]),
        Mutation::State => successor_builder.state(1),
        Mutation::TriggerKind => successor_builder.trigger_kind(2_u16.to_le_bytes()),
        Mutation::PolicyData => successor_builder.policy_script_hash([0x92; 32]),
        Mutation::Payload => successor_builder.payload_hash([0x93; 32]),
        Mutation::Reward => successor_builder.reward((REWARD + 1).to_le_bytes()),
        Mutation::NotAfter => successor_builder.not_after(1_u64.to_le_bytes()),
        Mutation::Owner => successor_builder.cancel_lock_hash([0x94; 32]),
        Mutation::Sequence => successor_builder.sequence(0_u64.to_le_bytes()),
        Mutation::SequenceOverflow => successor_builder.sequence(0_u64.to_le_bytes()),
        Mutation::Runs => successor_builder.remaining_runs(3_u32.to_le_bytes()),
        Mutation::RunsIncrease => successor_builder.remaining_runs(4_u32.to_le_bytes()),
        Mutation::Budget => successor_builder.remaining_budget(30_000_000_000_u64.to_le_bytes()),
        Mutation::BudgetIncrease => {
            successor_builder.remaining_budget(30_000_000_001_u64.to_le_bytes())
        }
        Mutation::Trigger => successor_builder
            .trigger_params_hash([0x22; 32])
            .not_before(0_u64.to_le_bytes()),
        _ => successor_builder,
    };
    let successor_data = successor_builder.build().as_bytes();
    let successor_policy = if matches!(mutation, Mutation::PolicyType) {
        other_policy
    } else {
        policy.clone()
    };

    let job_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(JOB_CAPACITY)
            .lock(job_lock.clone())
            .type_(Some(policy).pack())
            .build(),
        input_data,
    );
    let executor_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(EXECUTOR_CAPACITY)
            .lock(executor.lock.clone())
            .build(),
        Bytes::new(),
    );

    let mut builder = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(job_cell).build())
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
                .lock(recipient.lock)
                .build(),
        )
        .output_data(Bytes::new().pack())
        .output_data(Bytes::new().pack());

    let controlled_outputs: &[u32];
    if matches!(mutation, Mutation::Missing) {
        builder = builder
            .output(
                CellOutput::new_builder()
                    .capacity(SUCCESSOR_CAPACITY)
                    .lock(owner.lock.clone())
                    .build(),
            )
            .output_data(Bytes::new().pack());
        controlled_outputs = &[0, 1, 2];
    } else if matches!(mutation, Mutation::Multiple) {
        for _ in 0..2 {
            builder = builder
                .output(
                    CellOutput::new_builder()
                        .capacity(SUCCESSOR_CAPACITY / 2)
                        .lock(job_lock.clone())
                        .type_(Some(successor_policy.clone()).pack())
                        .build(),
                )
                .output_data(successor_data.clone().pack());
        }
        controlled_outputs = &[0, 1, 2, 3];
    } else if matches!(mutation, Mutation::Uncontrolled) {
        builder = builder
            .output(
                CellOutput::new_builder()
                    .capacity(SUCCESSOR_CAPACITY)
                    .lock(owner.lock.clone())
                    .build(),
            )
            .output_data(Bytes::new().pack())
            .output(
                CellOutput::new_builder()
                    .capacity(50_000_000_000_u64)
                    .lock(job_lock.clone())
                    .type_(Some(successor_policy).pack())
                    .build(),
            )
            .output_data(successor_data.pack());
        controlled_outputs = &[0, 1, 2];
    } else {
        builder = builder
            .output(
                CellOutput::new_builder()
                    .capacity(SUCCESSOR_CAPACITY)
                    .lock(job_lock)
                    .type_(Some(successor_policy).pack())
                    .build(),
            )
            .output_data(successor_data.pack());
        controlled_outputs = &[0, 1, 2];
    }

    let executor_change = if matches!(mutation, Mutation::Uncontrolled) {
        EXECUTOR_CAPACITY - FEE - 50_000_000_000_u64
    } else {
        EXECUTOR_CAPACITY - FEE
    };
    builder = builder
        .output(
            CellOutput::new_builder()
                .capacity(executor_change)
                .lock(executor.lock)
                .build(),
        )
        .output_data(Bytes::new().pack())
        .witness(
            execution_witness(0, 0, executor_hash, controlled_outputs)
                .as_bytes()
                .pack(),
        )
        .witness(WitnessArgs::default().as_bytes().pack())
        .cell_dep(secp_data_dep);
    let transaction = context.complete_tx(builder.build());
    let transaction = sign_single_secp_input(transaction, 1, &executor.key);
    RecurringCase {
        context,
        transaction,
    }
}

fn verify(case: &RecurringCase) -> Result<(), String> {
    case.context
        .verify_tx(&case.transaction, MAX_CYCLES)
        .map(|_| ())
        .map_err(|error| format!("{error:?}"))
}

fn assert_script_error(mutation: Mutation, code: i8) {
    let case = build_recurring_case(mutation);
    let error = verify(&case).expect_err("mutated successor must fail");
    assert!(
        error.contains(&code.to_string()),
        "unexpected error: {error}"
    );
}

#[test]
fn recurring_execution_creates_one_constrained_successor() {
    let case = build_recurring_case(Mutation::None);
    verify(&case).expect("valid recurring successor");
}

#[test]
fn recurrence_cannot_be_missing_forked_or_uncontrolled() {
    assert_script_error(Mutation::Missing, 24);
    assert_script_error(Mutation::Multiple, 24);
    assert_script_error(Mutation::Uncontrolled, 28);
}

#[test]
fn successor_preserves_every_immutable_field() {
    for mutation in [
        Mutation::Version,
        Mutation::Flags,
        Mutation::JobId,
        Mutation::State,
        Mutation::TriggerKind,
        Mutation::PolicyData,
        Mutation::Payload,
        Mutation::Reward,
        Mutation::NotAfter,
        Mutation::Owner,
    ] {
        assert_script_error(mutation, 25);
    }
    assert_script_error(Mutation::PolicyType, 17);
}

#[test]
fn successor_advances_sequence_runs_budget_and_trigger() {
    assert_script_error(Mutation::Sequence, 21);
    assert_script_error(Mutation::SequenceOverflow, 34);
    assert_script_error(Mutation::Runs, 27);
    assert_script_error(Mutation::RunsIncrease, 27);
    assert_script_error(Mutation::Budget, 26);
    assert_script_error(Mutation::BudgetIncrease, 26);
    assert_script_error(Mutation::Trigger, 18);
}
