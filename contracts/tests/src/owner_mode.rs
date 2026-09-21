use crate::fixtures::{deployed_contract, job_data, secp_wallet, sign_single_secp_input};
use ckb_testtool::{
    ckb_crypto::secp::Privkey,
    ckb_types::{
        bytes::Bytes,
        core::{TransactionBuilder, TransactionView},
        packed::{CellInput, CellOutput, WitnessArgs},
        prelude::*,
    },
    context::Context,
};

const MAX_CYCLES: u64 = 20_000_000;
const JOB_CAPACITY: u64 = 30_000_000_000;
const OWNER_CAPACITY: u64 = 20_000_000_000;
const FEE: u64 = 1_000_000;

#[derive(Clone, Copy)]
enum OwnerOperation {
    Unsupported,
    Cancel,
    Recover,
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
    transaction: TransactionView,
    owner_key: Privkey,
}

fn build_owner_case(
    operation: OwnerOperation,
    include_owner_input: bool,
    commit_wrong_owner: bool,
    alter_refund: bool,
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

    let job_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(JOB_CAPACITY)
            .lock(job_lock)
            .build(),
        job_data(cancel_lock_hash, [0x33; 32], 100_000_000, 1_000_000_000, 1),
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
fn altered_refund_fails() {
    let owner_case = build_owner_case(OwnerOperation::Cancel, true, false, true);
    let transaction = sign_single_secp_input(owner_case.transaction, 1, &owner_case.owner_key);
    let error = verify_owner_case(OwnerCase {
        transaction,
        ..owner_case
    })
    .expect_err("altered refund must fail");
    assert!(error.contains("28"), "unexpected error: {error}");
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
