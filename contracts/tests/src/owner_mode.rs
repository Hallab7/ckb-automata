use crate::fixtures::{
    deployed_contract, execution_witness, job_data, secp_wallet, sign_single_secp_input,
};
use ckb_testtool::{
    builtin::ALWAYS_SUCCESS,
    ckb_crypto::secp::Privkey,
    ckb_types::{
        bytes::Bytes,
        core::{ScriptHashType, TransactionBuilder, TransactionView},
        packed::{CellInput, CellOutput, Script, WitnessArgs},
        prelude::*,
    },
    context::Context,
};
use molecule::prelude::{Builder, Entity};

use crate::generated::JobDataV1;

const MAX_CYCLES: u64 = 20_000_000;
const JOB_CAPACITY: u64 = 200_000_000_000;
const OWNER_CAPACITY: u64 = 20_000_000_000;
const REWARD: u64 = 10_000_000_000;
const REMAINING_BUDGET: u64 = 30_000_000_000;
const FEE: u64 = 1_000_000;

#[derive(Clone, Copy)]
enum OwnerOperation {
    Unsupported,
    Cancel,
    Recover,
}

#[derive(Clone, Copy, Debug)]
enum JobMutation {
    None,
    UnsupportedVersion,
    InvalidState,
    ZeroRuns,
}

impl OwnerOperation {
    fn witness_byte(self) -> u8 {
        match self {
            Self::Unsupported => 0,
            Self::Cancel => 1,
            Self::Recover => 2,
        }
    }
}

struct OwnerCase {
    context: Context,
    job_lock: Script,
    transaction: TransactionView,
    owner_key: Privkey,
}

fn build_owner_case(
    operation: OwnerOperation,
    include_owner_input: bool,
    commit_wrong_owner: bool,
    alter_refund: bool,
) -> OwnerCase {
    build_owner_case_with_job(
        operation,
        include_owner_input,
        commit_wrong_owner,
        alter_refund,
        1,
        false,
    )
}

fn build_owner_case_with_job(
    operation: OwnerOperation,
    include_owner_input: bool,
    commit_wrong_owner: bool,
    alter_refund: bool,
    remaining_runs: u32,
    commit_wrong_policy: bool,
) -> OwnerCase {
    build_owner_case_with_mutation(
        operation,
        include_owner_input,
        commit_wrong_owner,
        alter_refund,
        remaining_runs,
        commit_wrong_policy,
        JobMutation::None,
    )
}

fn build_owner_case_with_mutation(
    operation: OwnerOperation,
    include_owner_input: bool,
    commit_wrong_owner: bool,
    alter_refund: bool,
    remaining_runs: u32,
    commit_wrong_policy: bool,
    mutation: JobMutation,
) -> OwnerCase {
    let mut context = Context::new_with_deterministic_rng();
    let job_lock = deployed_contract(&mut context, "job-lock");
    let owner = secp_wallet(&mut context, 1);
    let wrong_owner = secp_wallet(&mut context, 2);
    let secp_data_dep = owner.data_dep.clone();
    let owner_key = owner.key;
    let owner_lock = owner.lock;
    let committed_lock = if commit_wrong_owner {
        wrong_owner.lock
    } else {
        owner_lock.clone()
    };
    let cancel_lock_hash = committed_lock.calc_script_hash().unpack();
    let policy_code = context.deploy_cell(ALWAYS_SUCCESS.clone());
    let policy = context
        .build_script_with_hash_type(
            &policy_code,
            ScriptHashType::Data1,
            Bytes::from(vec![0x55; 32]),
        )
        .expect("policy script");
    let policy_hash = if commit_wrong_policy {
        [0x99; 32]
    } else {
        policy.calc_script_hash().unpack()
    };

    let mut job_bytes = job_data(
        cancel_lock_hash,
        policy_hash,
        REWARD,
        REMAINING_BUDGET,
        remaining_runs,
    );
    let job = JobDataV1::from_slice(&job_bytes).expect("fixture job data");
    job_bytes = match mutation {
        JobMutation::None => job,
        JobMutation::UnsupportedVersion => job.as_builder().version(2_u16.to_le_bytes()).build(),
        JobMutation::InvalidState => job.as_builder().state(1).build(),
        JobMutation::ZeroRuns => job.as_builder().remaining_runs(0_u32.to_le_bytes()).build(),
    }
    .as_bytes();

    let job_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(JOB_CAPACITY)
            .lock(job_lock.clone())
            .type_(Some(policy).pack())
            .build(),
        job_bytes,
    );

    let mut builder = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(job_cell).build());
    if include_owner_input {
        let owner_cell = context.create_cell(
            CellOutput::new_builder()
                .capacity(OWNER_CAPACITY)
                .lock(owner_lock.clone())
                .build(),
            Bytes::new(),
        );
        builder = builder.input(CellInput::new_builder().previous_output(owner_cell).build());
    }

    let refund_capacity = if alter_refund {
        JOB_CAPACITY - 1
    } else {
        JOB_CAPACITY
    };
    builder = builder
        .output(
            CellOutput::new_builder()
                .capacity(refund_capacity)
                .lock(committed_lock)
                .build(),
        )
        .output_data(Bytes::new().pack());
    if include_owner_input {
        builder = builder
            .output(
                CellOutput::new_builder()
                    .capacity(OWNER_CAPACITY - FEE)
                    .lock(owner_lock)
                    .build(),
            )
            .output_data(Bytes::new().pack());
    }

    let job_witness = WitnessArgs::new_builder()
        .input_type(Some(Bytes::from(vec![operation.witness_byte()])).pack())
        .build();
    builder = builder.witness(job_witness.as_bytes().pack());
    if include_owner_input {
        builder = builder.witness(WitnessArgs::default().as_bytes().pack());
    }

    let transaction = context.complete_tx(builder.cell_dep(secp_data_dep).build());
    OwnerCase {
        context,
        job_lock,
        transaction,
        owner_key,
    }
}

fn verify_owner_case(owner_case: OwnerCase) -> Result<(), String> {
    owner_case
        .context
        .verify_tx(&owner_case.transaction, MAX_CYCLES)
        .map(|_| ())
        .map_err(|error| format!("{error:?}"))
}

#[test]
fn valid_owner_cancellation_succeeds() {
    let owner_case = build_owner_case(OwnerOperation::Cancel, true, false, false);
    let transaction = sign_single_secp_input(owner_case.transaction, 1, &owner_case.owner_key);
    verify_owner_case(OwnerCase {
        transaction,
        ..owner_case
    })
    .expect("valid cancellation");
}

#[test]
fn recurring_live_job_can_be_cancelled_without_a_successor() {
    let owner_case =
        build_owner_case_with_job(OwnerOperation::Cancel, true, false, false, 3, false);
    let transaction = sign_single_secp_input(owner_case.transaction, 1, &owner_case.owner_key);
    verify_owner_case(OwnerCase {
        transaction,
        ..owner_case
    })
    .expect("valid recurring cancellation");
}

#[test]
fn cancellation_requires_the_committed_policy() {
    let owner_case = build_owner_case_with_job(OwnerOperation::Cancel, true, false, false, 1, true);
    let transaction = sign_single_secp_input(owner_case.transaction, 1, &owner_case.owner_key);
    let error = verify_owner_case(OwnerCase {
        transaction,
        ..owner_case
    })
    .expect_err("mismatched policy commitment must fail");
    assert!(error.contains("17"), "unexpected error: {error}");
}

#[test]
fn owner_can_recover_without_automata_services() {
    let owner_case = build_owner_case(OwnerOperation::Recover, true, false, false);
    let transaction = sign_single_secp_input(owner_case.transaction, 1, &owner_case.owner_key);
    verify_owner_case(OwnerCase {
        transaction,
        ..owner_case
    })
    .expect("standalone owner recovery");
}

#[test]
fn recovery_covers_unsupported_and_invalid_funded_jobs() {
    for mutation in [
        JobMutation::UnsupportedVersion,
        JobMutation::InvalidState,
        JobMutation::ZeroRuns,
    ] {
        let owner_case = build_owner_case_with_mutation(
            OwnerOperation::Recover,
            true,
            false,
            false,
            1,
            false,
            mutation,
        );
        let transaction = sign_single_secp_input(owner_case.transaction, 1, &owner_case.owner_key);
        verify_owner_case(OwnerCase {
            transaction,
            ..owner_case
        })
        .unwrap_or_else(|error| panic!("recovery for {mutation:?} failed: {error}"));
    }

    let owner_case =
        build_owner_case_with_job(OwnerOperation::Recover, true, false, false, 1, true);
    let transaction = sign_single_secp_input(owner_case.transaction, 1, &owner_case.owner_key);
    verify_owner_case(OwnerCase {
        transaction,
        ..owner_case
    })
    .expect("recovery for unsupported policy commitment");
}

#[test]
fn normal_cancellation_does_not_bypass_recovery_only_states() {
    for (mutation, code) in [
        (JobMutation::UnsupportedVersion, 11),
        (JobMutation::InvalidState, 13),
        (JobMutation::ZeroRuns, 10),
    ] {
        let owner_case = build_owner_case_with_mutation(
            OwnerOperation::Cancel,
            true,
            false,
            false,
            1,
            false,
            mutation,
        );
        let transaction = sign_single_secp_input(owner_case.transaction, 1, &owner_case.owner_key);
        let error = verify_owner_case(OwnerCase {
            transaction,
            ..owner_case
        })
        .expect_err("normal cancellation must reject recovery-only state");
        assert!(
            error.contains(&code.to_string()),
            "unexpected error: {error}"
        );
    }
}

#[test]
fn recovery_requires_the_committed_owner() {
    let missing_owner = build_owner_case(OwnerOperation::Recover, false, false, false);
    let error = verify_owner_case(missing_owner).expect_err("missing recovery owner must fail");
    assert!(error.contains("16"), "unexpected error: {error}");

    let wrong_owner = build_owner_case(OwnerOperation::Recover, true, true, false);
    let transaction = sign_single_secp_input(wrong_owner.transaction, 1, &wrong_owner.owner_key);
    let error = verify_owner_case(OwnerCase {
        transaction,
        ..wrong_owner
    })
    .expect_err("wrong recovery owner must fail");
    assert!(error.contains("16"), "unexpected error: {error}");
}

#[test]
fn recovery_cannot_redirect_job_capacity() {
    let owner_case = build_owner_case(OwnerOperation::Recover, true, false, true);
    let transaction = sign_single_secp_input(owner_case.transaction, 1, &owner_case.owner_key);
    let error = verify_owner_case(OwnerCase {
        transaction,
        ..owner_case
    })
    .expect_err("redirected recovery refund must fail");
    assert!(error.contains("28"), "unexpected error: {error}");
}

#[test]
fn recovery_cannot_bypass_a_protected_application_input() {
    let OwnerCase {
        mut context,
        transaction,
        owner_key,
        ..
    } = build_owner_case(OwnerOperation::Recover, true, false, false);
    let protected_owner = secp_wallet(&mut context, 9);
    let protected_capacity = 20_000_000_000;
    let protected_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(protected_capacity)
            .lock(protected_owner.lock)
            .build(),
        Bytes::new(),
    );
    let redirect_lock = transaction.outputs().get(0).expect("owner refund").lock();
    let transaction = transaction
        .as_advanced_builder()
        .input(
            CellInput::new_builder()
                .previous_output(protected_cell)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(protected_capacity)
                .lock(redirect_lock)
                .build(),
        )
        .output_data(Bytes::new().pack())
        .witness(WitnessArgs::default().as_bytes().pack())
        .cell_dep(protected_owner.data_dep)
        .build();
    let transaction = context.complete_tx(transaction);
    let transaction = sign_single_secp_input(transaction, 1, &owner_key);
    context
        .verify_tx(&transaction, MAX_CYCLES)
        .expect_err("recovery cannot suppress the protected input lock");
}

#[test]
fn wrong_owner_lock_hash_fails() {
    let owner_case = build_owner_case(OwnerOperation::Cancel, true, true, false);
    let transaction = sign_single_secp_input(owner_case.transaction, 1, &owner_case.owner_key);
    let error = verify_owner_case(OwnerCase {
        transaction,
        ..owner_case
    })
    .expect_err("wrong owner must fail");
    assert!(error.contains("16"), "unexpected error: {error}");
}

#[test]
fn missing_owner_input_fails() {
    let owner_case = build_owner_case(OwnerOperation::Cancel, false, false, false);
    let error = verify_owner_case(owner_case).expect_err("missing owner must fail");
    assert!(error.contains("16"), "unexpected error: {error}");
}

#[test]
fn invalid_wallet_signature_fails() {
    let owner_case = build_owner_case(OwnerOperation::Cancel, true, false, false);
    let mut witnesses: Vec<_> = owner_case.transaction.witnesses().into_iter().collect();
    witnesses[1] = WitnessArgs::new_builder()
        .lock(Some(Bytes::from(vec![0xff; 65])).pack())
        .build()
        .as_bytes()
        .pack();
    let transaction = owner_case
        .transaction
        .as_advanced_builder()
        .set_witnesses(witnesses)
        .build();
    verify_owner_case(OwnerCase {
        transaction,
        ..owner_case
    })
    .expect_err("invalid owner signature must fail");
}

#[test]
fn cancellation_cannot_divert_job_capacity_to_an_executor_reward() {
    let owner_case = build_owner_case(OwnerOperation::Cancel, true, false, true);
    let transaction = sign_single_secp_input(owner_case.transaction, 1, &owner_case.owner_key);
    let error = verify_owner_case(OwnerCase {
        transaction,
        ..owner_case
    })
    .expect_err("job-funded cancellation reward must fail");
    assert!(error.contains("28"), "unexpected error: {error}");
}

#[test]
fn cancellation_cannot_create_a_future_job() {
    let mut owner_case = build_owner_case(OwnerOperation::Cancel, true, false, false);
    let successor_capacity = 7_000_000_000;
    let mut outputs: Vec<_> = owner_case.transaction.outputs().into_iter().collect();
    let owner_change: u64 = outputs[1].capacity().unpack();
    outputs[1] = outputs[1]
        .clone()
        .as_builder()
        .capacity(owner_change - successor_capacity)
        .build();
    outputs.push(
        CellOutput::new_builder()
            .capacity(successor_capacity)
            .lock(owner_case.job_lock.clone())
            .build(),
    );
    let mut outputs_data: Vec<_> = owner_case.transaction.outputs_data().into_iter().collect();
    outputs_data.push(Bytes::new().pack());
    owner_case.transaction = owner_case
        .transaction
        .as_advanced_builder()
        .set_outputs(outputs)
        .set_outputs_data(outputs_data)
        .build();
    owner_case.transaction =
        sign_single_secp_input(owner_case.transaction, 1, &owner_case.owner_key);

    let error = verify_owner_case(owner_case).expect_err("cancellation successor must fail");
    assert!(error.contains("24"), "unexpected error: {error}");
}

#[test]
fn cancellation_and_execution_race_for_the_same_job_outpoint() {
    let OwnerCase {
        mut context,
        transaction,
        owner_key,
        ..
    } = build_owner_case(OwnerOperation::Cancel, true, false, false);
    let cancellation = sign_single_secp_input(transaction, 1, &owner_key);
    let job_out_point = cancellation
        .inputs()
        .get(0)
        .expect("job input")
        .previous_output();
    let owner_lock = cancellation.outputs().get(0).expect("owner refund").lock();

    let executor = secp_wallet(&mut context, 8);
    let executor_hash = executor.lock.calc_script_hash().unpack();
    let executor_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(OWNER_CAPACITY)
            .lock(executor.lock.clone())
            .build(),
        Bytes::new(),
    );
    let execution = TransactionBuilder::default()
        .input(
            CellInput::new_builder()
                .previous_output(job_out_point.clone())
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
                .capacity(JOB_CAPACITY - REWARD)
                .lock(owner_lock)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(OWNER_CAPACITY - FEE)
                .lock(executor.lock)
                .build(),
        )
        .output_data(Bytes::new().pack())
        .output_data(Bytes::new().pack())
        .output_data(Bytes::new().pack())
        .witness(
            execution_witness(0, 0, executor_hash, &[0, 1])
                .as_bytes()
                .pack(),
        )
        .witness(WitnessArgs::default().as_bytes().pack())
        .cell_dep(executor.data_dep)
        .build();
    let execution = context.complete_tx(execution);
    let execution = sign_single_secp_input(execution, 1, &executor.key);

    assert_eq!(
        job_out_point,
        execution
            .inputs()
            .get(0)
            .expect("competing job input")
            .previous_output()
    );
    context
        .verify_tx(&cancellation, MAX_CYCLES)
        .expect("valid cancellation contender");
    context
        .verify_tx(&execution, MAX_CYCLES)
        .expect("valid execution contender");
}

#[test]
fn malformed_execution_mode_is_rejected() {
    let owner_case = build_owner_case(OwnerOperation::Unsupported, true, false, false);
    let transaction = sign_single_secp_input(owner_case.transaction, 1, &owner_case.owner_key);
    let error = verify_owner_case(OwnerCase {
        transaction,
        ..owner_case
    })
    .expect_err("unsupported mode must fail");
    assert!(error.contains("15"), "unexpected error: {error}");
}
