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
    fixtures::{deployed_contract, job_data, secp_wallet, sign_single_secp_input},
    generated::JobDataV1,
};

const MAX_CYCLES: u64 = 20_000_000;
const JOB_CAPACITY: u64 = 200_000_000_000;
const FUNDING_CAPACITY: u64 = 100_000_000_000;
const ADDED_CAPACITY: u64 = 20_000_000_000;
const EXTRA_SUCCESSOR_CAPACITY: u64 = 7_000_000_000;
const FEE: u64 = 1_000_000;
const REWARD: u64 = 10_000_000_000;
const BUDGET: u64 = 30_000_000_000;

#[derive(Clone, Copy)]
enum Mutation {
    None,
    NoOwner,
    MissingSuccessor,
    MultipleSuccessors,
    PolicyType,
    Version,
    Flags,
    JobId,
    Sequence,
    State,
    TriggerKind,
    TriggerHash,
    PolicyData,
    Payload,
    NotBefore,
    NotAfter,
    Runs,
    Owner,
    RewardDecrease,
    BudgetDecrease,
    NoIncrease,
    RewardExceedsBudget,
    BudgetExceedsCapacity,
    CapacityDecrease,
}

struct TopUpCase {
    context: Context,
    transaction: TransactionView,
}

fn top_up_witness(successor_output_index: u32) -> WitnessArgs {
    let mut request = Vec::with_capacity(5);
    request.push(3);
    request.extend_from_slice(&successor_output_index.to_le_bytes());
    WitnessArgs::new_builder()
        .input_type(Some(Bytes::from(request)).pack())
        .build()
}

fn build_top_up_case(mutation: Mutation) -> TopUpCase {
    let mut context = Context::new_with_deterministic_rng();
    let job_lock = deployed_contract(&mut context, "job-lock");
    let owner = secp_wallet(&mut context, 11);
    let other = secp_wallet(&mut context, 12);
    let owner_hash = owner.lock.calc_script_hash().unpack();

    let policy_code = context.deploy_cell(ALWAYS_SUCCESS.clone());
    let policy = context
        .build_script_with_hash_type(
            &policy_code,
            ScriptHashType::Data1,
            Bytes::from(vec![0x71; 32]),
        )
        .expect("policy script");
    let other_policy = context
        .build_script_with_hash_type(
            &policy_code,
            ScriptHashType::Data1,
            Bytes::from(vec![0x72; 32]),
        )
        .expect("other policy script");
    let policy_hash = policy.calc_script_hash().unpack();
    let input_data = job_data(owner_hash, policy_hash, REWARD, BUDGET, 3);
    let input_job = JobDataV1::from_slice(&input_data).expect("fixture job data");

    let mut successor_builder = input_job
        .as_builder()
        .reward((REWARD + 2_000_000_000).to_le_bytes())
        .remaining_budget((BUDGET + 10_000_000_000).to_le_bytes());
    successor_builder = match mutation {
        Mutation::Version => successor_builder.version(2_u16.to_le_bytes()),
        Mutation::Flags => successor_builder.flags(1_u16.to_le_bytes()),
        Mutation::JobId => successor_builder.job_id([0x81; 32]),
        Mutation::Sequence => successor_builder.sequence(1_u64.to_le_bytes()),
        Mutation::State => successor_builder.state(1),
        Mutation::TriggerKind => successor_builder.trigger_kind(2_u16.to_le_bytes()),
        Mutation::TriggerHash => successor_builder.trigger_params_hash([0x82; 32]),
        Mutation::PolicyData => successor_builder.policy_script_hash([0x83; 32]),
        Mutation::Payload => successor_builder.payload_hash([0x84; 32]),
        Mutation::NotBefore => successor_builder.not_before(1_u64.to_le_bytes()),
        Mutation::NotAfter => successor_builder.not_after(1_u64.to_le_bytes()),
        Mutation::Runs => successor_builder.remaining_runs(4_u32.to_le_bytes()),
        Mutation::Owner => successor_builder.cancel_lock_hash([0x85; 32]),
        Mutation::RewardDecrease => successor_builder.reward((REWARD - 1).to_le_bytes()),
        Mutation::BudgetDecrease => successor_builder.remaining_budget((BUDGET - 1).to_le_bytes()),
        Mutation::NoIncrease => successor_builder
            .reward(REWARD.to_le_bytes())
            .remaining_budget(BUDGET.to_le_bytes()),
        Mutation::RewardExceedsBudget => successor_builder
            .reward((BUDGET + 1).to_le_bytes())
            .remaining_budget(BUDGET.to_le_bytes()),
        Mutation::BudgetExceedsCapacity => {
            successor_builder.remaining_budget(u64::MAX.to_le_bytes())
        }
        _ => successor_builder,
    };
    let successor_data = successor_builder.build().as_bytes();

    let job_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(JOB_CAPACITY)
            .lock(job_lock.clone())
            .type_(Some(policy.clone()).pack())
            .build(),
        input_data,
    );
    let funding_wallet = if matches!(mutation, Mutation::NoOwner) {
        &other
    } else {
        &owner
    };
    let funding_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(FUNDING_CAPACITY)
            .lock(funding_wallet.lock.clone())
            .build(),
        Bytes::new(),
    );

    let successor_capacity = if matches!(mutation, Mutation::CapacityDecrease) {
        JOB_CAPACITY - 1
    } else {
        JOB_CAPACITY + ADDED_CAPACITY
    };
    let extra_successor_capacity = if matches!(mutation, Mutation::MultipleSuccessors) {
        EXTRA_SUCCESSOR_CAPACITY
    } else {
        0
    };
    let successor_lock = if matches!(mutation, Mutation::MissingSuccessor) {
        owner.lock.clone()
    } else {
        job_lock.clone()
    };
    let successor_policy = if matches!(mutation, Mutation::PolicyType) {
        other_policy
    } else {
        policy.clone()
    };
    let change_capacity =
        JOB_CAPACITY + FUNDING_CAPACITY - successor_capacity - extra_successor_capacity - FEE;

    let mut builder = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(job_cell).build())
        .input(
            CellInput::new_builder()
                .previous_output(funding_cell)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(successor_capacity)
                .lock(successor_lock)
                .type_(Some(successor_policy).pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(change_capacity)
                .lock(funding_wallet.lock.clone())
                .build(),
        )
        .output_data(successor_data.clone().pack())
        .output_data(Bytes::new().pack());
    if matches!(mutation, Mutation::MultipleSuccessors) {
        builder = builder
            .output(
                CellOutput::new_builder()
                    .capacity(extra_successor_capacity)
                    .lock(job_lock)
                    .build(),
            )
            .output_data(Bytes::new().pack());
    }

    let transaction = builder
        .witness(top_up_witness(0).as_bytes().pack())
        .witness(WitnessArgs::default().as_bytes().pack())
        .cell_dep(funding_wallet.data_dep.clone())
        .build();
    let transaction = context.complete_tx(transaction);
    let transaction = sign_single_secp_input(transaction, 1, &funding_wallet.key);
    TopUpCase {
        context,
        transaction,
    }
}

fn verify(case: &TopUpCase) -> Result<(), String> {
    case.context
        .verify_tx(&case.transaction, MAX_CYCLES)
        .map(|_| ())
        .map_err(|error| format!("{error:?}"))
}

fn assert_script_error(mutation: Mutation, code: i8) {
    let case = build_top_up_case(mutation);
    let error = verify(&case).expect_err("mutated top-up must fail");
    assert!(
        error.contains(&code.to_string()),
        "unexpected error: {error}"
    );
}

#[test]
fn owner_can_increase_reward_budget_and_capacity() {
    verify(&build_top_up_case(Mutation::None)).expect("valid owner top-up");
}

#[test]
fn top_up_requires_owner_and_exactly_one_successor() {
    assert_script_error(Mutation::NoOwner, 16);
    assert_script_error(Mutation::MissingSuccessor, 24);
    assert_script_error(Mutation::MultipleSuccessors, 24);
}

#[test]
fn top_up_preserves_immutable_intent() {
    for mutation in [
        Mutation::Version,
        Mutation::Flags,
        Mutation::JobId,
        Mutation::Sequence,
        Mutation::State,
        Mutation::TriggerKind,
        Mutation::TriggerHash,
        Mutation::PolicyData,
        Mutation::Payload,
        Mutation::NotBefore,
        Mutation::NotAfter,
        Mutation::Runs,
        Mutation::Owner,
    ] {
        assert_script_error(mutation, 25);
    }
    assert_script_error(Mutation::PolicyType, 17);
}

#[test]
fn top_up_only_increases_funded_reward_or_budget() {
    assert_script_error(Mutation::RewardDecrease, 25);
    assert_script_error(Mutation::BudgetDecrease, 25);
    assert_script_error(Mutation::NoIncrease, 25);
    assert_script_error(Mutation::RewardExceedsBudget, 28);
    assert_script_error(Mutation::BudgetExceedsCapacity, 28);
    assert_script_error(Mutation::CapacityDecrease, 28);
}

pub(crate) fn benchmark_cases() -> Vec<crate::benchmarks::BenchmarkCase> {
    [
        ("job-lock.top-up.valid", Mutation::None, None),
        (
            "job-lock.top-up.invalid-budget",
            Mutation::BudgetExceedsCapacity,
            Some(28),
        ),
    ]
    .into_iter()
    .map(|(id, mutation, expected_error)| {
        let case = build_top_up_case(mutation);
        crate::benchmarks::BenchmarkCase::new(id, case.context, case.transaction, expected_error)
    })
    .collect()
}
