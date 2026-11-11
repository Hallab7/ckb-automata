use ckb_dao_utils::pack_dao_data;
use ckb_system_scripts::{BUNDLED_CELL, CODE_HASH_DAO};
use ckb_testtool::{
    builtin::ALWAYS_SUCCESS,
    ckb_hash::blake2b_256,
    ckb_types::{
        bytes::Bytes,
        core::{
            Capacity, EpochNumberWithFraction, HeaderBuilder, HeaderView, ScriptHashType,
            TransactionBuilder,
        },
        packed::{CellInput, CellOutput, Script, WitnessArgs},
        prelude::*,
    },
    context::Context,
};
use serde::Deserialize;

pub const TESTNET_DAO_TYPE_HASH: &str =
    "0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e";
pub const TESTNET_DAO_DEP_TX_HASH: &str =
    "0x8f8c79eb6671709633fe6a46de93c0fedc9c1b8a6527a18d3983879542635c9f";

pub fn deploy_real_dao(context: &mut Context) -> Script {
    let binary = BUNDLED_CELL
        .get("specs/cells/dao")
        .expect("pinned Nervos DAO system script");
    assert_eq!(blake2b_256(&binary), CODE_HASH_DAO);
    let out_point = context.deploy_cell(binary.to_vec().into());
    context
        .build_script_with_hash_type(&out_point, ScriptHashType::Data, Bytes::new())
        .expect("real Nervos DAO script")
}

pub fn dao_header(number: u64, epoch: u64, rate: u64) -> HeaderView {
    HeaderBuilder::default()
        .number(number)
        .epoch(EpochNumberWithFraction::new(epoch, 0, 1).full_value())
        .dao(pack_dao_data(
            rate,
            Capacity::shannons(7_777),
            Capacity::zero(),
            Capacity::zero(),
        ))
        .build()
}

const CKB: u64 = 100_000_000;
const PRINCIPAL: u64 = 10_000 * CKB;
const ABSOLUTE_EPOCH: u64 = 1 << 61;

fn identity(context: &mut Context, discriminator: u8) -> Script {
    let out_point = context.deploy_cell(ALWAYS_SUCCESS.clone());
    context
        .build_script_with_hash_type(
            &out_point,
            ScriptHashType::Data1,
            Bytes::from(vec![discriminator]),
        )
        .expect("test identity")
}

fn cell(
    context: &mut Context,
    capacity: u64,
    lock: Script,
) -> ckb_testtool::ckb_types::packed::OutPoint {
    context.create_cell(
        CellOutput::new_builder()
            .capacity(capacity)
            .lock(lock)
            .build(),
        Bytes::new(),
    )
}

#[derive(Clone, Copy)]
enum OwnerExitMutation {
    None,
    WrongIndex,
    Capacity,
    Data,
    TypeScript,
    MissingHeader,
}

fn owner_exit_case(
    mutation: OwnerExitMutation,
) -> (Context, ckb_testtool::ckb_types::core::TransactionView) {
    let mut context = Context::new_with_deterministic_rng();
    let vault_lock = identity(&mut context, 1);
    let owner_lock = identity(&mut context, 2);
    let wallet_lock = identity(&mut context, 3);
    let dao_type = deploy_real_dao(&mut context);
    let deposit_header = dao_header(42, 0, 1_000);
    context.insert_header(deposit_header.clone());

    let job = cell(&mut context, 400 * CKB, vault_lock.clone());
    let vault = context.create_cell(
        CellOutput::new_builder()
            .capacity(PRINCIPAL)
            .lock(vault_lock)
            .type_(Some(dao_type.clone()).pack())
            .build(),
        Bytes::from(vec![0; 8]),
    );
    context.link_cell_with_block(vault.clone(), deposit_header.hash(), 0);
    let funding = cell(&mut context, 100 * CKB, wallet_lock.clone());

    let withdrawing_type = if matches!(mutation, OwnerExitMutation::TypeScript) {
        Some(
            deploy_real_dao(&mut context)
                .as_builder()
                .args(Bytes::from(vec![1]).pack())
                .build(),
        )
    } else {
        Some(dao_type)
    };
    let withdrawing = CellOutput::new_builder()
        .capacity(if matches!(mutation, OwnerExitMutation::Capacity) {
            PRINCIPAL - 1
        } else {
            PRINCIPAL
        })
        .lock(owner_lock)
        .type_(withdrawing_type.pack())
        .build();
    let withdrawing_data = if matches!(mutation, OwnerExitMutation::Data) {
        41_u64
    } else {
        42_u64
    };
    let change = CellOutput::new_builder()
        .capacity(99 * CKB)
        .lock(wallet_lock)
        .build();
    let padding = CellOutput::new_builder()
        .capacity(400 * CKB)
        .lock(identity(&mut context, 4))
        .build();
    let mut builder = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(job).build())
        .input(CellInput::new_builder().previous_output(vault).build())
        .input(CellInput::new_builder().previous_output(funding).build());
    builder = if matches!(mutation, OwnerExitMutation::WrongIndex) {
        builder
            .output(padding)
            .output(change)
            .output(withdrawing)
            .output_data(Bytes::new().pack())
            .output_data(Bytes::new().pack())
            .output_data(Bytes::copy_from_slice(&withdrawing_data.to_le_bytes()).pack())
    } else {
        builder
            .output(padding)
            .output(withdrawing)
            .output(change)
            .output_data(Bytes::new().pack())
            .output_data(Bytes::copy_from_slice(&withdrawing_data.to_le_bytes()).pack())
            .output_data(Bytes::new().pack())
    };
    if !matches!(mutation, OwnerExitMutation::MissingHeader) {
        builder = builder.header_dep(deposit_header.hash());
    }
    (context.clone(), context.complete_tx(builder.build()))
}

#[test]
fn real_dao_accepts_same_index_owner_exit_with_wallet_funding_and_change() {
    let (context, transaction) = owner_exit_case(OwnerExitMutation::None);
    context
        .verify_tx(&transaction, 10_000_000)
        .expect("canonical owner exit");
}

#[test]
fn real_dao_rejects_owner_exit_boundary_mutations() {
    for mutation in [
        OwnerExitMutation::WrongIndex,
        OwnerExitMutation::Capacity,
        OwnerExitMutation::Data,
        OwnerExitMutation::TypeScript,
        OwnerExitMutation::MissingHeader,
    ] {
        let (context, transaction) = owner_exit_case(mutation);
        context
            .verify_tx(&transaction, 10_000_000)
            .expect_err("mutated owner exit must fail");
    }
}

fn mature_claim_case(since: u64) -> (Context, ckb_testtool::ckb_types::core::TransactionView) {
    let mut context = Context::new_with_deterministic_rng();
    let owner_lock = identity(&mut context, 5);
    let wallet_lock = identity(&mut context, 6);
    let dao_type = deploy_real_dao(&mut context);
    let deposit_header = dao_header(42, 0, 1_000);
    let withdrawing_header = dao_header(84, 179, 1_100);
    context.insert_header(deposit_header.clone());
    context.insert_header(withdrawing_header.clone());

    let funding = cell(&mut context, 100 * CKB, wallet_lock.clone());
    let vault_output = CellOutput::new_builder()
        .capacity(PRINCIPAL)
        .lock(owner_lock.clone())
        .type_(Some(dao_type).pack())
        .build();
    let occupied = vault_output
        .occupied_capacity(Capacity::bytes(8).expect("DAO data capacity"))
        .expect("occupied capacity")
        .as_u64();
    let vault = context.create_cell(vault_output, Bytes::copy_from_slice(&42_u64.to_le_bytes()));
    context.link_cell_with_block(vault.clone(), withdrawing_header.hash(), 0);
    let maximum = occupied + ((PRINCIPAL - occupied) * 1_100) / 1_000;
    let transaction = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(funding).build())
        .input(
            CellInput::new_builder()
                .since(since)
                .previous_output(vault)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(99 * CKB)
                .lock(wallet_lock)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(maximum)
                .lock(owner_lock)
                .build(),
        )
        .output_data(Bytes::new().pack())
        .output_data(Bytes::new().pack())
        .header_dep(deposit_header.hash())
        .header_dep(withdrawing_header.hash())
        .witness(WitnessArgs::default().as_bytes().pack())
        .witness(
            WitnessArgs::new_builder()
                .input_type(Some(Bytes::copy_from_slice(&0_u64.to_le_bytes())).pack())
                .build()
                .as_bytes()
                .pack(),
        )
        .build();
    (context.clone(), context.complete_tx(transaction))
}

#[test]
fn real_dao_accepts_mature_owner_claim_and_rejects_wrong_since() {
    let (context, transaction) = mature_claim_case(ABSOLUTE_EPOCH | 180);
    context
        .verify_tx(&transaction, 10_000_000)
        .expect("canonical mature owner claim");

    let (context, transaction) = mature_claim_case(ABSOLUTE_EPOCH | 179);
    context
        .verify_tx(&transaction, 10_000_000)
        .expect_err("immature owner claim must fail");
}

#[test]
fn v2_state_transition_fixture_cannot_restore_an_always_success_dao() {
    let fixture = include_str!("dao_harvest_v2_contract.rs");
    assert!(fixture.contains("let dao_type = deploy_real_dao(&mut context);"));
    assert!(!fixture.contains("let dao_type = always_success(&mut context"));
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    nervos_dao: ManifestScript,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestScript {
    code_hash: String,
    hash_type: String,
    cell_dep: ManifestCellDep,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestCellDep {
    out_point: ManifestOutPoint,
    dep_type: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestOutPoint {
    tx_hash: String,
    index: String,
}

#[test]
fn bundled_dao_binary_and_testnet_identity_are_pinned() {
    let binary = BUNDLED_CELL
        .get("specs/cells/dao")
        .expect("pinned Nervos DAO system script");
    assert_eq!(blake2b_256(&binary), CODE_HASH_DAO);

    let manifest: Manifest = serde_json::from_str(include_str!(
        "../../../deploy/manifests/dao-harvest-v2-testnet.json"
    ))
    .expect("testnet manifest");
    assert_eq!(manifest.nervos_dao.code_hash, TESTNET_DAO_TYPE_HASH);
    assert_eq!(manifest.nervos_dao.hash_type, "type");
    assert_eq!(
        manifest.nervos_dao.cell_dep.out_point.tx_hash,
        TESTNET_DAO_DEP_TX_HASH
    );
    assert_eq!(manifest.nervos_dao.cell_dep.out_point.index, "0x2");
    assert_eq!(manifest.nervos_dao.cell_dep.dep_type, "code");
}
