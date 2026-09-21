use std::path::PathBuf;

use ckb_system_scripts::BUNDLED_CELL;
use ckb_testtool::{
    ckb_crypto::secp::Privkey,
    ckb_hash::{blake2b_256, new_blake2b},
    ckb_types::{
        H256,
        bytes::Bytes,
        core::{
            Capacity, EpochNumberWithFraction, HeaderBuilder, HeaderView, ScriptHashType,
            TransactionBuilder, TransactionView,
        },
        packed::{CellDep, CellInput, CellOutput, OutPoint, Script, WitnessArgs},
        prelude::*,
    },
    context::Context,
};
use molecule::prelude::{Builder, Entity};

use crate::generated::JobDataV1;

#[derive(Clone, Debug)]
pub struct ExecutorIdentity {
    pub public_key: [u8; 33],
    pub lock: Script,
    pub lock_hash: [u8; 32],
}

#[derive(Clone, Debug)]
pub struct FixtureCell {
    pub data: Bytes,
    pub input: CellInput,
    pub out_point: OutPoint,
    pub output: CellOutput,
}

pub struct SecpWallet {
    pub data_dep: CellDep,
    pub key: Privkey,
    pub lock: Script,
}

pub fn contract_binary(name: &str) -> Bytes {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/riscv64imac-unknown-none-elf/release")
        .join(name);
    std::fs::read(&path)
        .unwrap_or_else(|error| {
            panic!(
                "read contract binary at {} after running cargo build-contracts: {error}",
                path.display()
            )
        })
        .into()
}

pub fn deployed_contract(context: &mut Context, name: &str) -> Script {
    let out_point = context.deploy_cell(contract_binary(name));
    context
        .build_script_with_hash_type(&out_point, ScriptHashType::Data1, Bytes::new())
        .expect("deployed contract script")
}

pub fn secp_wallet(context: &mut Context, key_seed: u8) -> SecpWallet {
    let secp_data = BUNDLED_CELL
        .get("specs/cells/secp256k1_data")
        .expect("bundled secp data");
    let secp_lock_code = BUNDLED_CELL
        .get("specs/cells/secp256k1_blake160_sighash_all")
        .expect("bundled secp lock");
    let data_out_point = context.deploy_cell(secp_data.to_vec().into());
    let lock_out_point = context.deploy_cell(secp_lock_code.to_vec().into());
    let key = Privkey::from_slice(&[key_seed; 32]);
    let public_key = key.pubkey().expect("wallet public key");
    let key_hash = blake2b_256(public_key.serialize());
    let lock = context
        .build_script_with_hash_type(
            &lock_out_point,
            ScriptHashType::Data,
            Bytes::copy_from_slice(&key_hash[..20]),
        )
        .expect("secp wallet lock");
    SecpWallet {
        data_dep: CellDep::new_builder().out_point(data_out_point).build(),
        key,
        lock,
    }
}

pub fn sign_single_secp_input(
    transaction: TransactionView,
    input_index: usize,
    key: &Privkey,
) -> TransactionView {
    const SIGNATURE_SIZE: usize = 65;
    let mut witnesses: Vec<_> = transaction.witnesses().into_iter().collect();
    let zeroed_witness = WitnessArgs::default()
        .as_builder()
        .lock(Some(Bytes::from(vec![0_u8; SIGNATURE_SIZE])).pack())
        .build();
    let zeroed_bytes = zeroed_witness.as_bytes();

    let mut hasher = new_blake2b();
    hasher.update(&transaction.hash().raw_data());
    hasher.update(&(zeroed_bytes.len() as u64).to_le_bytes());
    hasher.update(&zeroed_bytes);
    for witness in witnesses.iter().skip(transaction.inputs().len()) {
        hasher.update(&(witness.raw_data().len() as u64).to_le_bytes());
        hasher.update(&witness.raw_data());
    }
    let mut message = [0_u8; 32];
    hasher.finalize(&mut message);
    let signature = key
        .sign_recoverable(&H256::from(message))
        .expect("secp signature")
        .serialize();
    witnesses[input_index] = zeroed_witness
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

pub fn execution_witness(
    mode: u8,
    reward_output_index: u32,
    executor_hash: [u8; 32],
    controlled_output_indices: &[u32],
) -> WitnessArgs {
    let mut request = Vec::with_capacity(38 + controlled_output_indices.len() * 4);
    request.push(mode);
    request.extend_from_slice(&reward_output_index.to_le_bytes());
    request.extend_from_slice(&executor_hash);
    request.push(
        controlled_output_indices
            .len()
            .try_into()
            .expect("fixture output count"),
    );
    for index in controlled_output_indices {
        request.extend_from_slice(&index.to_le_bytes());
    }
    WitnessArgs::new_builder()
        .input_type(Some(Bytes::from(request)).pack())
        .build()
}

pub fn job_data(
    cancel_lock_hash: [u8; 32],
    policy_script_hash: [u8; 32],
    reward: u64,
    remaining_budget: u64,
    remaining_runs: u32,
) -> Bytes {
    JobDataV1::new_builder()
        .version(1_u16.to_le_bytes())
        .flags(0_u16.to_le_bytes())
        .job_id([0x11; 32])
        .sequence(0_u64.to_le_bytes())
        .state(0)
        .trigger_kind(1_u16.to_le_bytes())
        .trigger_params_hash([0x22; 32])
        .policy_script_hash(policy_script_hash)
        .payload_hash([0x44; 32])
        .reward(reward.to_le_bytes())
        .remaining_budget(remaining_budget.to_le_bytes())
        .not_before(0_u64.to_le_bytes())
        .not_after(0_u64.to_le_bytes())
        .remaining_runs(remaining_runs.to_le_bytes())
        .cancel_lock_hash(cancel_lock_hash)
        .build()
        .as_bytes()
}

pub fn seeded_script(code_seed: u8, hash_type: ScriptHashType, args: &[u8]) -> Script {
    Script::new_builder()
        .code_hash([code_seed; 32].pack())
        .hash_type(hash_type)
        .args(Bytes::copy_from_slice(args).pack())
        .build()
}

pub fn owner_lock(seed: u8) -> Script {
    seeded_script(seed, ScriptHashType::Type, &[seed; 20])
}

pub fn executor_identity(seed: u8) -> ExecutorIdentity {
    let mut public_key = [seed; 33];
    public_key[0] = 2 + (seed & 1);
    let key_hash = blake2b_256(public_key);
    let lock = seeded_script(0xec, ScriptHashType::Type, &key_hash[..20]);
    let lock_hash = lock.calc_script_hash().unpack();
    ExecutorIdentity {
        public_key,
        lock,
        lock_hash,
    }
}

pub fn witness_args(
    lock: Option<Bytes>,
    input_type: Option<Bytes>,
    output_type: Option<Bytes>,
) -> WitnessArgs {
    WitnessArgs::new_builder()
        .lock(lock.pack())
        .input_type(input_type.pack())
        .output_type(output_type.pack())
        .build()
}

pub fn header(number: u64, epoch_number: u64, timestamp: u64) -> HeaderView {
    HeaderBuilder::default()
        .number(number)
        .epoch(EpochNumberWithFraction::new(epoch_number, 0, 1).full_value())
        .timestamp(timestamp)
        .build()
}

pub fn occupied_capacity(output: &CellOutput, data: &Bytes) -> Capacity {
    output
        .occupied_capacity(Capacity::bytes(data.len()).expect("fixture data capacity"))
        .expect("fixture cell capacity")
}

pub fn create_cell(
    context: &mut Context,
    out_point_seed: u8,
    lock: Script,
    type_script: Option<Script>,
    data: Bytes,
    extra_capacity: u64,
) -> FixtureCell {
    let empty_capacity_output = CellOutput::new_builder()
        .lock(lock)
        .type_(type_script.pack())
        .build();
    let minimum = occupied_capacity(&empty_capacity_output, &data).as_u64();
    let output = empty_capacity_output
        .as_builder()
        .capacity(
            minimum
                .checked_add(extra_capacity)
                .expect("fixture capacity overflow"),
        )
        .build();
    let out_point = OutPoint::new_builder()
        .tx_hash([out_point_seed; 32].pack())
        .build();
    context.create_cell_with_out_point(out_point.clone(), output.clone(), data.clone());
    let input = CellInput::new_builder()
        .previous_output(out_point.clone())
        .build();
    FixtureCell {
        data,
        input,
        out_point,
        output,
    }
}

pub fn golden_transaction() -> TransactionView {
    let mut context = Context::new_with_deterministic_rng();
    let owner = owner_lock(0x11);
    let job_type = seeded_script(0x22, ScriptHashType::Data1, &[0x33; 32]);
    let cell = create_cell(
        &mut context,
        0x10,
        owner,
        Some(job_type),
        Bytes::from(vec![0x44; 48]),
        100_000_000,
    );
    let header = header(42, 7, 1_700_000_000_000);
    context.insert_header(header.clone());

    let executor = executor_identity(0x55);
    let mut operation = Vec::with_capacity(34);
    operation.push(0);
    operation.extend_from_slice(&executor.public_key);
    let witness = witness_args(
        Some(Bytes::from(vec![0x66; 65])),
        Some(Bytes::from(operation)),
        None,
    );

    TransactionBuilder::default()
        .input(cell.input)
        .output(cell.output)
        .output_data(cell.data.pack())
        .header_dep(header.hash())
        .witness(witness.as_bytes().pack())
        .build()
}
