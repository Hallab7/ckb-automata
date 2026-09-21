use std::path::PathBuf;

use ckb_system_scripts::BUNDLED_CELL;
use ckb_testtool::{
    ckb_crypto::secp::Privkey,
    ckb_hash::{blake2b_256, new_blake2b},
    ckb_types::{
        H256,
        bytes::Bytes,
        core::{ScriptHashType, TransactionBuilder, TransactionView},
        packed::{CellDep, CellInput, CellOutput, Script, WitnessArgs},
        prelude::*,
    },
    context::Context,
};
use molecule::prelude::Builder;

use crate::generated::JobDataV1;

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

fn contract_binary() -> Bytes {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/riscv64imac-unknown-none-elf/release/job-lock");
    std::fs::read(&path)
        .unwrap_or_else(|error| {
            panic!(
                "read Job Lock binary at {} after running cargo build-contracts: {error}",
                path.display()
            )
        })
        .into()
}

fn blake160(data: &[u8]) -> [u8; 20] {
    let digest = blake2b_256(data);
    digest[..20].try_into().expect("blake160 length")
}

fn job_data(cancel_lock_hash: [u8; 32]) -> Bytes {
    JobDataV1::new_builder()
        .version(1_u16.to_le_bytes())
        .flags(0_u16.to_le_bytes())
        .job_id([0x11; 32])
        .sequence(0_u64.to_le_bytes())
        .state(0)
        .trigger_kind(1_u16.to_le_bytes())
        .trigger_params_hash([0x22; 32])
        .policy_script_hash([0x33; 32])
        .payload_hash([0x44; 32])
        .reward(100_000_000_u64.to_le_bytes())
        .remaining_budget(1_000_000_000_u64.to_le_bytes())
        .not_before(0_u64.to_le_bytes())
        .not_after(0_u64.to_le_bytes())
        .remaining_runs(1_u32.to_le_bytes())
        .cancel_lock_hash(cancel_lock_hash)
        .build()
        .as_bytes()
}

fn secp_lock(
    context: &mut Context,
    lock_code: &ckb_testtool::ckb_types::packed::OutPoint,
    key: &Privkey,
) -> Script {
    let public_key = key.pubkey().expect("owner public key");
    context
        .build_script_with_hash_type(
            lock_code,
            ScriptHashType::Data,
            Bytes::copy_from_slice(&blake160(&public_key.serialize())),
        )
        .expect("owner lock")
}

fn build_owner_case(
    operation: OwnerOperation,
    include_owner_input: bool,
    commit_wrong_owner: bool,
    alter_refund: bool,
) -> OwnerCase {
    let mut context = Context::new_with_deterministic_rng();
    let job_code = context.deploy_cell(contract_binary());
    let secp_data = BUNDLED_CELL
        .get("specs/cells/secp256k1_data")
        .expect("bundled secp data");
    let secp_lock_code = BUNDLED_CELL
        .get("specs/cells/secp256k1_blake160_sighash_all")
        .expect("bundled secp lock");
    let secp_data_out_point = context.deploy_cell(secp_data.to_vec().into());
    let secp_lock_out_point = context.deploy_cell(secp_lock_code.to_vec().into());

    let owner_key = Privkey::from_slice(&[1_u8; 32]);
    let wrong_key = Privkey::from_slice(&[2_u8; 32]);
    let owner_lock = secp_lock(&mut context, &secp_lock_out_point, &owner_key);
    let wrong_owner_lock = secp_lock(&mut context, &secp_lock_out_point, &wrong_key);
    let committed_lock = if commit_wrong_owner {
        wrong_owner_lock
    } else {
        owner_lock.clone()
    };
    let cancel_lock_hash = committed_lock.calc_script_hash().unpack();

    let job_lock = context
        .build_script_with_hash_type(&job_code, ScriptHashType::Data1, Bytes::new())
        .expect("Job Lock script");
    let job_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(JOB_CAPACITY)
            .lock(job_lock)
            .build(),
        job_data(cancel_lock_hash),
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

    let secp_data_dep = CellDep::new_builder()
        .out_point(secp_data_out_point)
        .build();
    let transaction = context.complete_tx(builder.cell_dep(secp_data_dep).build());
    OwnerCase {
        context,
        transaction,
        owner_key,
    }
}

fn sign_owner_input(transaction: TransactionView, key: &Privkey) -> TransactionView {
    const SIGNATURE_SIZE: usize = 65;
    let mut witnesses: Vec<_> = transaction.witnesses().into_iter().collect();
    let owner_witness = WitnessArgs::default()
        .as_builder()
        .lock(Some(Bytes::from(vec![0_u8; SIGNATURE_SIZE])).pack())
        .build();
    let owner_bytes = owner_witness.as_bytes();

    let mut hasher = new_blake2b();
    hasher.update(&transaction.hash().raw_data());
    hasher.update(&(owner_bytes.len() as u64).to_le_bytes());
    hasher.update(&owner_bytes);
    let mut message = [0_u8; 32];
    hasher.finalize(&mut message);
    let signature = key
        .sign_recoverable(&H256::from(message))
        .expect("owner signature")
        .serialize();
    witnesses[1] = owner_witness
        .as_builder()
        .lock(Some(Bytes::from(signature)).pack())
        .build()
        .as_bytes()
        .pack();

    transaction
        .as_advanced_builder()
        .set_witnesses(witnesses)
        .build()
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
    let transaction = sign_owner_input(owner_case.transaction, &owner_case.owner_key);
    verify_owner_case(OwnerCase {
        transaction,
        ..owner_case
    })
    .expect("valid cancellation");
}

#[test]
fn owner_can_recover_without_automata_services() {
    let owner_case = build_owner_case(OwnerOperation::Recover, true, false, false);
    let transaction = sign_owner_input(owner_case.transaction, &owner_case.owner_key);
    verify_owner_case(OwnerCase {
        transaction,
        ..owner_case
    })
    .expect("standalone owner recovery");
}

#[test]
fn wrong_owner_lock_hash_fails() {
    let owner_case = build_owner_case(OwnerOperation::Cancel, true, true, false);
    let transaction = sign_owner_input(owner_case.transaction, &owner_case.owner_key);
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
    let transaction = sign_owner_input(owner_case.transaction, &owner_case.owner_key);
    let error = verify_owner_case(OwnerCase {
        transaction,
        ..owner_case
    })
    .expect_err("altered refund must fail");
    assert!(error.contains("28"), "unexpected error: {error}");
}

#[test]
fn executor_mode_is_not_accepted_yet() {
    let owner_case = build_owner_case(OwnerOperation::Unsupported, true, false, false);
    let transaction = sign_owner_input(owner_case.transaction, &owner_case.owner_key);
    let error = verify_owner_case(OwnerCase {
        transaction,
        ..owner_case
    })
    .expect_err("unsupported mode must fail");
    assert!(error.contains("15"), "unexpected error: {error}");
}
