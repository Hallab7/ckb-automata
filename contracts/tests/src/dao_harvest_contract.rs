use ckb_testtool::{
    builtin::ALWAYS_SUCCESS,
    ckb_types::{
        bytes::Bytes,
        core::{
            Capacity, EpochNumberWithFraction, HeaderBuilder, ScriptHashType, TransactionBuilder,
            TransactionView,
        },
        packed::{CellInput, CellOutput, Script, WitnessArgs},
        prelude::*,
    },
    context::Context,
};
use molecule::prelude::{Builder, Entity};

use crate::{
    dao_harvest::{dao_harvest_payload_hash, maximum_withdraw_capacity, prepare_executor_set_hash},
    fixtures::{deployed_contract, execution_witness},
    generated::JobDataV1,
    generated_dao_harvest::DaoHarvestPayloadV1,
};

const MAX_CYCLES: u64 = 40_000_000;
const PRINCIPAL: u64 = 100_000_000_000;
const JOB_CAPACITY: u64 = 60_000_000_000;
const EXECUTOR_CAPACITY: u64 = 20_000_000_000;
const REWARD: u64 = 6_100_000_000;
const FEE: u64 = 1_000_000;
const EPOCH_METRIC: u64 = 0b01 << 61;

#[derive(Clone, Copy)]
enum PrepareMutation {
    None,
    Principal,
    DaoType,
    UnauthorizedExecutor,
    MissingBoundJob,
    PolicyBinding,
    Budget,
}

#[derive(Clone, Copy)]
enum RollMutation {
    None,
    Principal,
    Payout,
    Header,
    MalformedDaoData,
    Early,
}

struct ContractCase {
    context: Context,
    transaction: TransactionView,
}

fn always_success_script(context: &mut Context, discriminator: u8) -> Script {
    let code = context.deploy_cell(ALWAYS_SUCCESS.clone());
    context
        .build_script_with_hash_type(
            &code,
            ScriptHashType::Data1,
            Bytes::from(vec![discriminator]),
        )
        .expect("always-success script")
}

fn epoch(number: u64) -> u64 {
    EPOCH_METRIC | number | (1 << 40)
}

fn vault_args(
    job_id: [u8; 32],
    owner_hash: [u8; 32],
    job_lock_hash: [u8; 32],
    policy_hash: [u8; 32],
) -> Bytes {
    let mut args = Vec::with_capacity(128);
    args.extend_from_slice(&job_id);
    args.extend_from_slice(&owner_hash);
    args.extend_from_slice(&job_lock_hash);
    args.extend_from_slice(&policy_hash);
    Bytes::from(args)
}

fn harvest_payload(
    owner_hash: [u8; 32],
    payout_hash: [u8; 32],
    vault_hash: [u8; 32],
    dao_type_hash: [u8; 32],
    executor_hashes: &mut [[u8; 32]],
) -> Bytes {
    let executor_set_hash =
        prepare_executor_set_hash(executor_hashes).expect("valid executor fixture");
    DaoHarvestPayloadV1::new_builder()
        .version(1_u16.to_le_bytes())
        .owner_lock_hash(owner_hash)
        .payout_lock_hash(payout_hash)
        .vault_lock_hash(vault_hash)
        .dao_type_hash(dao_type_hash)
        .principal_capacity(PRINCIPAL.to_le_bytes())
        .prepare_executor_set_hash(executor_set_hash)
        .executor_reward(REWARD.to_le_bytes())
        .min_compensation(1_u64.to_le_bytes())
        .prepare_buffer_epochs(((1 << 63) | EPOCH_METRIC | 4).to_le_bytes())
        .confirmation_margin_epochs(((1 << 63) | EPOCH_METRIC | 1).to_le_bytes())
        .total_cycles(1_u32.to_le_bytes())
        .end_epoch_since(0_u64.to_le_bytes())
        .build()
        .as_bytes()
}

fn payload_envelope(payload: &Bytes, executor_hashes: &[[u8; 32]]) -> Bytes {
    let mut envelope = payload.to_vec();
    if !executor_hashes.is_empty() {
        envelope.push(executor_hashes.len() as u8);
        for hash in executor_hashes {
            envelope.extend_from_slice(hash);
        }
    }
    Bytes::from(envelope)
}

#[allow(clippy::too_many_arguments)]
fn job_data(
    owner_hash: [u8; 32],
    policy_hash: [u8; 32],
    payload_hash: [u8; 32],
    sequence: u64,
    remaining_runs: u32,
    remaining_budget: u64,
    not_before: u64,
    trigger_hash: [u8; 32],
) -> Bytes {
    JobDataV1::new_builder()
        .version(1_u16.to_le_bytes())
        .flags(0_u16.to_le_bytes())
        .job_id([0x11; 32])
        .sequence(sequence.to_le_bytes())
        .state(0)
        .trigger_kind(2_u16.to_le_bytes())
        .trigger_params_hash(trigger_hash)
        .policy_script_hash(policy_hash)
        .payload_hash(payload_hash)
        .reward(REWARD.to_le_bytes())
        .remaining_budget(remaining_budget.to_le_bytes())
        .not_before(not_before.to_le_bytes())
        .not_after(0_u64.to_le_bytes())
        .remaining_runs(remaining_runs.to_le_bytes())
        .cancel_lock_hash(owner_hash)
        .build()
        .as_bytes()
}

fn vault_witness(operation: u8, job_input_index: u32) -> WitnessArgs {
    let mut request = vec![0, operation];
    request.extend_from_slice(&job_input_index.to_le_bytes());
    WitnessArgs::new_builder()
        .lock(Some(Bytes::from(request)).pack())
        .build()
}

fn dao_header(
    number: u64,
    epoch_number: u64,
    accumulated_rate: u64,
) -> ckb_testtool::ckb_types::core::HeaderView {
    let mut dao = [0_u8; 32];
    dao[..8].copy_from_slice(&7_777_u64.to_le_bytes());
    dao[8..16].copy_from_slice(&accumulated_rate.to_le_bytes());
    HeaderBuilder::default()
        .number(number)
        .epoch(EpochNumberWithFraction::new(epoch_number, 0, 1).full_value())
        .dao(dao.pack())
        .build()
}

fn build_creation_case(wrong_dao_type: bool) -> ContractCase {
    let mut context = Context::new_with_deterministic_rng();
    let policy = deployed_contract(&mut context, "dao-harvest-policy");
    let vault_code = context.deploy_cell(crate::fixtures::contract_binary("harvest-vault-lock"));
    let job_lock = deployed_contract(&mut context, "job-lock");
    let owner = always_success_script(&mut context, 1);
    let payout = always_success_script(&mut context, 2);
    let executor = always_success_script(&mut context, 3);
    let dao_type = always_success_script(&mut context, 4);
    let wrong_type = always_success_script(&mut context, 5);
    let owner_hash = owner.calc_script_hash().unpack();
    let payout_hash = payout.calc_script_hash().unpack();
    let executor_hash = executor.calc_script_hash().unpack();
    let job_lock_hash = job_lock.calc_script_hash().unpack();
    let policy_hash = policy.calc_script_hash().unpack();
    let vault = context
        .build_script_with_hash_type(
            &vault_code,
            ScriptHashType::Data1,
            vault_args([0x11; 32], owner_hash, job_lock_hash, policy_hash),
        )
        .expect("vault script");
    let vault_hash = vault.calc_script_hash().unpack();
    let dao_type_hash = dao_type.calc_script_hash().unpack();
    let mut executor_set = [executor_hash];
    let payload = harvest_payload(
        owner_hash,
        payout_hash,
        vault_hash,
        dao_type_hash,
        &mut executor_set,
    );
    let payload_hash =
        dao_harvest_payload_hash(&policy_hash, &payload).expect("harvest payload hash");
    let data = job_data(
        owner_hash,
        policy_hash,
        payload_hash,
        0,
        2,
        REWARD * 2,
        epoch(0),
        [0x21; 32],
    );
    let funding = context.create_cell(
        CellOutput::new_builder()
            .capacity(PRINCIPAL + JOB_CAPACITY)
            .lock(owner)
            .build(),
        Bytes::new(),
    );
    let transaction = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(funding).build())
        .output(
            CellOutput::new_builder()
                .capacity(PRINCIPAL)
                .lock(vault)
                .type_(Some(if wrong_dao_type { wrong_type } else { dao_type }).pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(JOB_CAPACITY)
                .lock(job_lock)
                .type_(Some(policy).pack())
                .build(),
        )
        .output_data(Bytes::from(vec![0; 8]).pack())
        .output_data(data.pack())
        .witness(
            WitnessArgs::new_builder()
                .output_type(Some(payload_envelope(&payload, &executor_set)).pack())
                .build()
                .as_bytes()
                .pack(),
        )
        .build();
    let transaction = context.complete_tx(transaction);
    ContractCase {
        context,
        transaction,
    }
}

fn build_prepare_case(mutation: PrepareMutation) -> ContractCase {
    let mut context = Context::new_with_deterministic_rng();
    let job_lock = deployed_contract(&mut context, "job-lock");
    let policy = deployed_contract(&mut context, "dao-harvest-policy");
    let vault_code = context.deploy_cell(crate::fixtures::contract_binary("harvest-vault-lock"));
    let owner = always_success_script(&mut context, 11);
    let payout = always_success_script(&mut context, 12);
    let approved_executor = always_success_script(&mut context, 13);
    let other_executor = always_success_script(&mut context, 14);
    let dao_type = always_success_script(&mut context, 15);
    let wrong_type = always_success_script(&mut context, 16);
    let owner_hash = owner.calc_script_hash().unpack();
    let payout_hash = payout.calc_script_hash().unpack();
    let approved_hash = approved_executor.calc_script_hash().unpack();
    let executor = if matches!(mutation, PrepareMutation::UnauthorizedExecutor) {
        other_executor
    } else {
        approved_executor
    };
    let executor_hash = executor.calc_script_hash().unpack();
    let job_lock_hash = job_lock.calc_script_hash().unpack();
    let policy_hash = policy.calc_script_hash().unpack();
    let bound_policy_hash = if matches!(mutation, PrepareMutation::PolicyBinding) {
        [0x99; 32]
    } else {
        policy_hash
    };
    let vault = context
        .build_script_with_hash_type(
            &vault_code,
            ScriptHashType::Data1,
            vault_args([0x11; 32], owner_hash, job_lock_hash, bound_policy_hash),
        )
        .expect("vault script");
    let vault_hash = vault.calc_script_hash().unpack();
    let dao_type_hash = dao_type.calc_script_hash().unpack();
    let mut approved_set = [approved_hash];
    let payload = harvest_payload(
        owner_hash,
        payout_hash,
        vault_hash,
        dao_type_hash,
        &mut approved_set,
    );
    let payload_hash =
        dao_harvest_payload_hash(&policy_hash, &payload).expect("harvest payload hash");
    let input_data = job_data(
        owner_hash,
        policy_hash,
        payload_hash,
        0,
        2,
        REWARD * 2,
        epoch(0),
        [0x31; 32],
    );
    let successor_data = job_data(
        owner_hash,
        policy_hash,
        payload_hash,
        1,
        1,
        if matches!(mutation, PrepareMutation::Budget) {
            REWARD - 1
        } else {
            REWARD
        },
        epoch(1),
        [0x32; 32],
    );
    let vault_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(PRINCIPAL)
            .lock(vault.clone())
            .type_(Some(dao_type.clone()).pack())
            .build(),
        Bytes::from(vec![0; 8]),
    );
    let job_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(JOB_CAPACITY)
            .lock(job_lock.clone())
            .type_(Some(policy.clone()).pack())
            .build(),
        input_data,
    );
    let executor_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(EXECUTOR_CAPACITY)
            .lock(executor.clone())
            .build(),
        Bytes::new(),
    );
    let output_principal = if matches!(mutation, PrepareMutation::Principal) {
        PRINCIPAL - 1
    } else {
        PRINCIPAL
    };
    let output_type = if matches!(mutation, PrepareMutation::DaoType) {
        wrong_type
    } else {
        dao_type
    };
    let job_index = if matches!(mutation, PrepareMutation::MissingBoundJob) {
        2
    } else {
        1
    };
    let executor_change = EXECUTOR_CAPACITY - FEE + (PRINCIPAL - output_principal);
    let vault_operation = vault_witness(0, job_index);
    let job_operation = execution_witness(0, 1, executor_hash, &[1, 2])
        .as_builder()
        .output_type(Some(payload_envelope(&payload, &approved_set)).pack())
        .build();
    let transaction = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(vault_cell).build())
        .input(
            CellInput::new_builder()
                .since(epoch(0))
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
                .capacity(output_principal)
                .lock(vault)
                .type_(Some(output_type).pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(REWARD)
                .lock(executor.clone())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(JOB_CAPACITY - REWARD)
                .lock(job_lock)
                .type_(Some(policy).pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(executor_change)
                .lock(executor)
                .build(),
        )
        .output_data(Bytes::copy_from_slice(&42_u64.to_le_bytes()).pack())
        .output_data(Bytes::new().pack())
        .output_data(successor_data.pack())
        .output_data(Bytes::new().pack())
        .witness(vault_operation.as_bytes().pack())
        .witness(job_operation.as_bytes().pack())
        .witness(WitnessArgs::default().as_bytes().pack())
        .build();
    let transaction = context.complete_tx(transaction);
    ContractCase {
        context,
        transaction,
    }
}

fn build_roll_case(mutation: RollMutation) -> ContractCase {
    build_roll_case_with_payout(mutation, false)
}

fn build_roll_case_with_payout(mutation: RollMutation, payout_to_owner: bool) -> ContractCase {
    let mut context = Context::new_with_deterministic_rng();
    let job_lock = deployed_contract(&mut context, "job-lock");
    let policy = deployed_contract(&mut context, "dao-harvest-policy");
    let vault_code = context.deploy_cell(crate::fixtures::contract_binary("harvest-vault-lock"));
    let owner = always_success_script(&mut context, 21);
    let payout = if payout_to_owner {
        owner.clone()
    } else {
        always_success_script(&mut context, 22)
    };
    let executor = always_success_script(&mut context, 23);
    let dao_type = always_success_script(&mut context, 24);
    let owner_hash = owner.calc_script_hash().unpack();
    let payout_hash = payout.calc_script_hash().unpack();
    let executor_hash = executor.calc_script_hash().unpack();
    let job_lock_hash = job_lock.calc_script_hash().unpack();
    let policy_hash = policy.calc_script_hash().unpack();
    let vault = context
        .build_script_with_hash_type(
            &vault_code,
            ScriptHashType::Data1,
            vault_args([0x11; 32], owner_hash, job_lock_hash, policy_hash),
        )
        .expect("vault script");
    let vault_hash = vault.calc_script_hash().unpack();
    let dao_type_hash = dao_type.calc_script_hash().unpack();
    let mut executor_set = [executor_hash];
    let payload = harvest_payload(
        owner_hash,
        payout_hash,
        vault_hash,
        dao_type_hash,
        &mut executor_set,
    );
    let payload_hash =
        dao_harvest_payload_hash(&policy_hash, &payload).expect("harvest payload hash");
    let input_data = job_data(
        owner_hash,
        policy_hash,
        payload_hash,
        1,
        1,
        REWARD,
        epoch(1),
        [0x42; 32],
    );
    let dao_data = if matches!(mutation, RollMutation::MalformedDaoData) {
        Bytes::from(vec![1; 7])
    } else {
        Bytes::copy_from_slice(&42_u64.to_le_bytes())
    };
    let vault_output = CellOutput::new_builder()
        .capacity(PRINCIPAL)
        .lock(vault.clone())
        .type_(Some(dao_type.clone()).pack())
        .build();
    let vault_cell = context.create_cell(vault_output.clone(), dao_data);
    let job_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(JOB_CAPACITY)
            .lock(job_lock)
            .type_(Some(policy.clone()).pack())
            .build(),
        input_data,
    );
    let executor_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(EXECUTOR_CAPACITY)
            .lock(executor.clone())
            .build(),
        Bytes::new(),
    );

    let deposit_rate = if matches!(mutation, RollMutation::Header) {
        900_u64
    } else {
        1_000
    };
    let withdrawing_rate = 1_100_u64;
    let deposit_header = dao_header(42, 1, deposit_rate);
    let withdrawing_header = dao_header(84, 181, withdrawing_rate);
    context.insert_header(deposit_header.clone());
    context.insert_header(withdrawing_header.clone());
    context.link_cell_with_block(vault_cell.clone(), withdrawing_header.hash(), 0);
    let occupied = vault_output
        .occupied_capacity(Capacity::bytes(8).expect("DAO data capacity"))
        .expect("vault occupied capacity")
        .as_u64();
    let canonical_compensation =
        maximum_withdraw_capacity(PRINCIPAL, occupied, 1_000, withdrawing_rate)
            .expect("maximum withdraw")
            - PRINCIPAL;
    let payout_capacity = if matches!(mutation, RollMutation::Payout) {
        canonical_compensation + 1
    } else {
        canonical_compensation
    };
    let output_principal = if matches!(mutation, RollMutation::Principal) {
        PRINCIPAL - 1
    } else {
        PRINCIPAL
    };
    let owner_refund = JOB_CAPACITY - REWARD;
    let executor_change = EXECUTOR_CAPACITY
        .checked_sub(canonical_compensation)
        .and_then(|value| value.checked_sub(FEE))
        .and_then(|value| value.checked_add(PRINCIPAL - output_principal))
        .and_then(|value| value.checked_sub(payout_capacity - canonical_compensation))
        .expect("funded executor fixture");
    let vault_operation = vault_witness(1, 1)
        .as_builder()
        .input_type(Some(Bytes::copy_from_slice(&0_u64.to_le_bytes())).pack())
        .build();
    let job_operation = execution_witness(0, 1, executor_hash, &[1, 3])
        .as_builder()
        .output_type(Some(payload.clone()).pack())
        .build();
    let job_since = if matches!(mutation, RollMutation::Early) {
        epoch(0)
    } else {
        epoch(1)
    };
    let transaction = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(vault_cell).build())
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
        .output(vault_output.as_builder().capacity(output_principal).build())
        .output(
            CellOutput::new_builder()
                .capacity(REWARD)
                .lock(executor.clone())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(payout_capacity)
                .lock(payout)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(owner_refund)
                .lock(owner)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(executor_change)
                .lock(executor)
                .build(),
        )
        .output_data(Bytes::from(vec![0; 8]).pack())
        .output_data(Bytes::new().pack())
        .output_data(Bytes::new().pack())
        .output_data(Bytes::new().pack())
        .output_data(Bytes::new().pack())
        .header_dep(deposit_header.hash())
        .header_dep(withdrawing_header.hash())
        .witness(vault_operation.as_bytes().pack())
        .witness(job_operation.as_bytes().pack())
        .witness(WitnessArgs::default().as_bytes().pack())
        .build();
    let transaction = context.complete_tx(transaction);
    ContractCase {
        context,
        transaction,
    }
}

fn build_owner_vault_case(include_owner: bool) -> ContractCase {
    let mut context = Context::new_with_deterministic_rng();
    let vault_code = context.deploy_cell(crate::fixtures::contract_binary("harvest-vault-lock"));
    let job_lock = deployed_contract(&mut context, "job-lock");
    let owner = always_success_script(&mut context, 31);
    let stranger = always_success_script(&mut context, 32);
    let dao_type = always_success_script(&mut context, 33);
    let owner_hash = owner.calc_script_hash().unpack();
    let job_lock_hash = job_lock.calc_script_hash().unpack();
    let vault = context
        .build_script_with_hash_type(
            &vault_code,
            ScriptHashType::Data1,
            vault_args([0x11; 32], owner_hash, job_lock_hash, [0; 32]),
        )
        .expect("vault script");
    let vault_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(PRINCIPAL)
            .lock(vault)
            .type_(Some(dao_type).pack())
            .build(),
        Bytes::from(vec![0; 8]),
    );
    let authority = if include_owner {
        owner.clone()
    } else {
        stranger
    };
    let authority_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(EXECUTOR_CAPACITY)
            .lock(authority)
            .build(),
        Bytes::new(),
    );
    let transaction = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(vault_cell).build())
        .input(
            CellInput::new_builder()
                .previous_output(authority_cell)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(PRINCIPAL + EXECUTOR_CAPACITY - FEE)
                .lock(owner)
                .build(),
        )
        .output_data(Bytes::new().pack())
        .witness(
            WitnessArgs::new_builder()
                .lock(Some(Bytes::from(vec![1, 3])).pack())
                .build()
                .as_bytes()
                .pack(),
        )
        .witness(WitnessArgs::default().as_bytes().pack())
        .build();
    let transaction = context.complete_tx(transaction);
    ContractCase {
        context,
        transaction,
    }
}

fn verify(case: &ContractCase) -> Result<(), String> {
    case.context
        .verify_tx(&case.transaction, MAX_CYCLES)
        .map(|_| ())
        .map_err(|error| format!("{error:?}"))
}

fn assert_prepare_fails(mutation: PrepareMutation, code: i8) {
    let error = verify(&build_prepare_case(mutation)).expect_err("mutated prepare must fail");
    assert!(
        error.contains(&code.to_string()),
        "expected script error {code}, got {error}"
    );
}

fn assert_roll_fails(mutation: RollMutation, code: i8) {
    let error = verify(&build_roll_case(mutation)).expect_err("mutated roll must fail");
    assert!(
        error.contains(&code.to_string()),
        "expected script error {code}, got {error}"
    );
}

#[test]
fn dao_harvest_creation_binds_the_exact_vault_and_dao_type() {
    verify(&build_creation_case(false)).expect("valid harvest creation");
    let error = verify(&build_creation_case(true)).expect_err("wrong DAO type must fail");
    assert!(error.contains("36"), "unexpected error: {error}");
}

#[test]
fn approved_executor_prepares_without_changing_principal() {
    verify(&build_prepare_case(PrepareMutation::None)).expect("valid harvest prepare");
}

#[test]
fn prepare_rejects_principal_type_authority_and_job_substitution() {
    assert_prepare_fails(PrepareMutation::Principal, 37);
    assert_prepare_fails(PrepareMutation::DaoType, 36);
    assert_prepare_fails(PrepareMutation::UnauthorizedExecutor, 39);
    assert_prepare_fails(PrepareMutation::MissingBoundJob, 43);
    assert_prepare_fails(PrepareMutation::PolicyBinding, 43);
    assert_prepare_fails(PrepareMutation::Budget, 28);
}

#[test]
fn claim_pays_exact_compensation_and_redeposits_principal() {
    verify(&build_roll_case(RollMutation::None)).expect("valid harvest roll");
}

#[test]
fn claim_can_pay_compensation_to_the_owner_lock() {
    verify(&build_roll_case_with_payout(RollMutation::None, true))
        .expect("valid owner compensation payout");

    let error = verify(&build_roll_case_with_payout(RollMutation::Payout, true))
        .expect_err("incorrect owner compensation must fail");
    assert!(error.contains("38"), "unexpected error: {error}");
}

#[test]
fn claim_rejects_value_header_data_and_timing_mutations() {
    assert_roll_fails(RollMutation::Principal, 37);
    assert_roll_fails(RollMutation::Payout, 38);
    assert_roll_fails(RollMutation::Header, 38);
    assert_roll_fails(RollMutation::MalformedDaoData, 36);
    assert_roll_fails(RollMutation::Early, 23);
}

#[test]
fn owner_can_exit_the_vault_without_service_authority() {
    verify(&build_owner_vault_case(true)).expect("owner-authorized vault exit");
    let error = verify(&build_owner_vault_case(false)).expect_err("stranger vault exit must fail");
    assert!(error.contains("16"), "unexpected error: {error}");
}

pub(crate) fn benchmark_cases() -> Vec<crate::benchmarks::BenchmarkCase> {
    [
        (
            "dao-harvest.prepare.valid",
            build_prepare_case(PrepareMutation::None),
            None,
        ),
        (
            "dao-harvest.prepare.invalid-principal",
            build_prepare_case(PrepareMutation::Principal),
            Some(37),
        ),
        (
            "dao-harvest.roll.valid",
            build_roll_case(RollMutation::None),
            None,
        ),
        (
            "dao-harvest.roll.invalid-payout",
            build_roll_case(RollMutation::Payout),
            Some(38),
        ),
    ]
    .into_iter()
    .map(|(id, case, expected_error)| {
        crate::benchmarks::BenchmarkCase::new(id, case.context, case.transaction, expected_error)
    })
    .collect()
}
