use ckb_testtool::{
    builtin::ALWAYS_SUCCESS,
    ckb_types::{
        bytes::Bytes,
        core::{Capacity, ScriptHashType, TransactionBuilder, TransactionView},
        packed::{CellInput, CellOutput, WitnessArgs},
        prelude::*,
    },
    context::Context,
};
use molecule::prelude::{Builder, Entity};

use crate::{
    campaign::refund_commitment,
    fixtures::{
        deployed_contract, execution_witness, job_data, secp_wallet, sign_single_secp_input,
    },
    generated::JobDataV1,
    generated_campaign::CampaignDataV1,
};

const MAX_CYCLES: u64 = 30_000_000;
const JOB_CAPACITY: u64 = 200_000_000_000;
const EXECUTOR_CAPACITY: u64 = 20_000_000_000;
const REWARD: u64 = 10_000_000_000;
const PLEDGED: u64 = 20_000_000_000;
const TARGET: u64 = 15_000_000_000;
const DEADLINE: u64 = 42;
const FEE: u64 = 1_000_000;

#[derive(Clone, Copy)]
enum Mutation {
    None,
    Early,
    UnderTarget,
    WrongRecipient,
    RewardRedirect,
    ExtraSuccessOutput,
}

struct SuccessCase {
    context: Context,
    transaction: TransactionView,
}

fn campaign_data(state: u8, target: u64, success_lock_hash: [u8; 32]) -> Bytes {
    let mut records = Vec::with_capacity(76);
    records.extend_from_slice(&[0x01; 32]);
    records.extend_from_slice(&0_u32.to_le_bytes());
    records.extend_from_slice(&[0x61; 32]);
    records.extend_from_slice(&PLEDGED.to_le_bytes());
    CampaignDataV1::new_builder()
        .version(1_u16.to_le_bytes())
        .state(state)
        .campaign_id([0x11; 32])
        .pledged(PLEDGED.to_le_bytes())
        .pledge_count(1_u32.to_le_bytes())
        .target(target.to_le_bytes())
        .deadline_since(DEADLINE.to_le_bytes())
        .success_lock_hash(success_lock_hash)
        .refund_commitment(refund_commitment(1, &records))
        .build()
        .as_bytes()
}

fn build_success_case(mutation: Mutation) -> SuccessCase {
    let mut context = Context::new_with_deterministic_rng();
    let job_lock = deployed_contract(&mut context, "job-lock");
    let executor = secp_wallet(&mut context, 21);
    let owner = secp_wallet(&mut context, 22);
    let executor_hash = executor.lock.calc_script_hash().unpack();
    let owner_hash = owner.lock.calc_script_hash().unpack();

    let campaign_code = context.deploy_cell(crate::fixtures::contract_binary("demo-campaign-type"));
    let campaign_type = context
        .build_script_with_hash_type(
            &campaign_code,
            ScriptHashType::Data1,
            Bytes::from(vec![0x11; 32]),
        )
        .expect("campaign type");
    let campaign_type_hash: [u8; 32] = campaign_type.calc_script_hash().unpack();
    let deadline_code = context.deploy_cell(crate::fixtures::contract_binary("deadline-policy"));
    let deadline_policy = context
        .build_script_with_hash_type(
            &deadline_code,
            ScriptHashType::Data1,
            Bytes::copy_from_slice(&campaign_type_hash),
        )
        .expect("deadline policy");
    let deadline_policy_hash = deadline_policy.calc_script_hash().unpack();
    let campaign_lock_code = context.deploy_cell(ALWAYS_SUCCESS.clone());
    let campaign_lock = context
        .build_script_with_hash_type(
            &campaign_lock_code,
            ScriptHashType::Data1,
            Bytes::from(vec![0x77; 20]),
        )
        .expect("campaign lock");
    let success_recipient = crate::fixtures::seeded_script(0x81, ScriptHashType::Type, &[0x82; 20]);
    let success_hash = success_recipient.calc_script_hash().unpack();

    let target = if matches!(mutation, Mutation::UnderTarget) {
        PLEDGED + 1
    } else {
        TARGET
    };
    let input_campaign_data = campaign_data(0, target, success_hash);
    let terminal_campaign_data = campaign_data(1, target, success_hash);
    let empty_terminal = CellOutput::new_builder()
        .lock(campaign_lock.clone())
        .type_(Some(campaign_type.clone()).pack())
        .build();
    let terminal_capacity = empty_terminal
        .occupied_capacity(
            Capacity::bytes(terminal_campaign_data.len()).expect("terminal data capacity"),
        )
        .expect("terminal occupied capacity")
        .as_u64();
    let campaign_cell = context.create_cell(
        empty_terminal
            .clone()
            .as_builder()
            .capacity(terminal_capacity + PLEDGED)
            .build(),
        input_campaign_data,
    );

    let mut input_job_data = job_data(owner_hash, deadline_policy_hash, REWARD, 30_000_000_000, 1);
    input_job_data = JobDataV1::from_slice(&input_job_data)
        .expect("job data")
        .as_builder()
        .not_before(DEADLINE.to_le_bytes())
        .build()
        .as_bytes();
    let job_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(JOB_CAPACITY)
            .lock(job_lock)
            .type_(Some(deadline_policy).pack())
            .build(),
        input_job_data,
    );
    let executor_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(EXECUTOR_CAPACITY)
            .lock(executor.lock.clone())
            .build(),
        Bytes::new(),
    );

    let job_since = if matches!(mutation, Mutation::Early) {
        DEADLINE - 1
    } else {
        DEADLINE
    };
    let reward_lock = if matches!(mutation, Mutation::RewardRedirect) {
        owner.lock.clone()
    } else {
        executor.lock.clone()
    };
    let payout_lock = if matches!(mutation, Mutation::WrongRecipient) {
        owner.lock.clone()
    } else {
        success_recipient.clone()
    };
    let extra_capacity = if matches!(mutation, Mutation::ExtraSuccessOutput) {
        7_000_000_000
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
        .input(
            CellInput::new_builder()
                .previous_output(campaign_cell)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(REWARD)
                .lock(reward_lock)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(JOB_CAPACITY - REWARD)
                .lock(owner.lock)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(PLEDGED)
                .lock(payout_lock)
                .build(),
        )
        .output(
            empty_terminal
                .as_builder()
                .capacity(terminal_capacity)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(EXECUTOR_CAPACITY - FEE - extra_capacity)
                .lock(executor.lock)
                .build(),
        )
        .output_data(Bytes::new().pack())
        .output_data(Bytes::new().pack())
        .output_data(Bytes::new().pack())
        .output_data(terminal_campaign_data.pack())
        .output_data(Bytes::new().pack());
    if extra_capacity > 0 {
        builder = builder
            .output(
                CellOutput::new_builder()
                    .capacity(extra_capacity)
                    .lock(success_recipient)
                    .build(),
            )
            .output_data(Bytes::new().pack());
    }

    let transaction = builder
        .witness(
            execution_witness(0, 0, executor_hash, &[0, 1])
                .as_bytes()
                .pack(),
        )
        .witness(WitnessArgs::default().as_bytes().pack())
        .witness(WitnessArgs::default().as_bytes().pack())
        .cell_dep(executor.data_dep)
        .build();
    let transaction = context.complete_tx(transaction);
    let transaction = sign_single_secp_input(transaction, 1, &executor.key);
    SuccessCase {
        context,
        transaction,
    }
}

fn verify(case: &SuccessCase) -> Result<(), String> {
    case.context
        .verify_tx(&case.transaction, MAX_CYCLES)
        .map(|_| ())
        .map_err(|error| format!("{error:?}"))
}

fn assert_fails(mutation: Mutation, code: i8) {
    let case = build_success_case(mutation);
    let error = verify(&case).expect_err("mutated success finalization must fail");
    assert!(
        error.contains(&code.to_string()),
        "unexpected error: {error}"
    );
}

#[test]
fn successful_deadline_settles_campaign_and_reward_atomically() {
    verify(&build_success_case(Mutation::None)).expect("valid success finalization");
}

#[test]
fn success_finalization_rejects_early_and_under_target_attempts() {
    assert_fails(Mutation::Early, 23);
    assert_fails(Mutation::UnderTarget, 32);
}

#[test]
fn success_finalization_binds_both_recipients_and_output_count() {
    assert_fails(Mutation::WrongRecipient, 32);
    assert_fails(Mutation::RewardRedirect, 30);
    assert_fails(Mutation::ExtraSuccessOutput, 32);
}
