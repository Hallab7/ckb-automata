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
const REFUND_ONE: u64 = 8_000_000_000;
const REFUND_TWO: u64 = 12_000_000_000;
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
    Refund,
    RefundAtTarget,
    RefundCommitment,
    RefundState,
    RefundWrongRecipient,
    RefundAmount,
    RefundOrder,
    RefundMixed,
}

struct SuccessCase {
    context: Context,
    transaction: TransactionView,
}

fn refund_records(refund_hashes: [[u8; 32]; 2]) -> Vec<u8> {
    let mut records = Vec::with_capacity(152);
    for (seed, index, lock_hash, amount) in [
        (0x01, 0_u32, refund_hashes[0], REFUND_ONE),
        (0x02, 1_u32, refund_hashes[1], REFUND_TWO),
    ] {
        records.extend_from_slice(&[seed; 32]);
        records.extend_from_slice(&index.to_le_bytes());
        records.extend_from_slice(&lock_hash);
        records.extend_from_slice(&amount.to_le_bytes());
    }
    records
}

fn campaign_data(state: u8, target: u64, success_lock_hash: [u8; 32], records: &[u8]) -> Bytes {
    CampaignDataV1::new_builder()
        .version(1_u16.to_le_bytes())
        .state(state)
        .campaign_id([0x11; 32])
        .pledged(PLEDGED.to_le_bytes())
        .pledge_count(2_u32.to_le_bytes())
        .target(target.to_le_bytes())
        .deadline_since(DEADLINE.to_le_bytes())
        .success_lock_hash(success_lock_hash)
        .refund_commitment(refund_commitment(2, records))
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
    let refund_one = crate::fixtures::seeded_script(0x83, ScriptHashType::Type, &[0x84; 20]);
    let refund_two = crate::fixtures::seeded_script(0x85, ScriptHashType::Type, &[0x86; 20]);
    let records = refund_records([
        refund_one.calc_script_hash().unpack(),
        refund_two.calc_script_hash().unpack(),
    ]);

    let refund_attempt = matches!(
        mutation,
        Mutation::Refund
            | Mutation::RefundAtTarget
            | Mutation::RefundCommitment
            | Mutation::RefundState
            | Mutation::RefundWrongRecipient
            | Mutation::RefundAmount
            | Mutation::RefundOrder
            | Mutation::RefundMixed
    );
    let target = if matches!(mutation, Mutation::RefundAtTarget) {
        PLEDGED
    } else if matches!(
        mutation,
        Mutation::UnderTarget
            | Mutation::Refund
            | Mutation::RefundCommitment
            | Mutation::RefundState
            | Mutation::RefundWrongRecipient
            | Mutation::RefundAmount
            | Mutation::RefundOrder
            | Mutation::RefundMixed
    ) {
        PLEDGED + 1
    } else {
        TARGET
    };
    let input_campaign_data = campaign_data(0, target, success_hash, &records);
    let terminal_state = if matches!(mutation, Mutation::RefundState) {
        0
    } else if refund_attempt {
        2
    } else {
        1
    };
    let mut terminal_campaign_data = campaign_data(terminal_state, target, success_hash, &records);
    if matches!(mutation, Mutation::RefundCommitment) {
        terminal_campaign_data = CampaignDataV1::from_slice(&terminal_campaign_data)
            .expect("terminal campaign data")
            .as_builder()
            .refund_commitment([0x99; 32])
            .build()
            .as_bytes();
    }
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
    let mixed_capacity = if matches!(mutation, Mutation::RefundMixed) {
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
                .lock(owner.lock.clone())
                .build(),
        )
        .output_data(Bytes::new().pack())
        .output_data(Bytes::new().pack());
    if refund_attempt {
        let first_amount = if matches!(mutation, Mutation::RefundAmount) {
            REFUND_ONE + 1
        } else {
            REFUND_ONE
        };
        let second_amount = if matches!(mutation, Mutation::RefundAmount) {
            REFUND_TWO - 1
        } else {
            REFUND_TWO
        };
        let first_lock = if matches!(mutation, Mutation::RefundWrongRecipient) {
            owner.lock.clone()
        } else {
            refund_one.clone()
        };
        if matches!(mutation, Mutation::RefundOrder) {
            builder = builder
                .output(
                    CellOutput::new_builder()
                        .capacity(second_amount)
                        .lock(refund_two.clone())
                        .build(),
                )
                .output(
                    CellOutput::new_builder()
                        .capacity(first_amount)
                        .lock(first_lock)
                        .build(),
                );
        } else {
            builder = builder
                .output(
                    CellOutput::new_builder()
                        .capacity(first_amount)
                        .lock(first_lock)
                        .build(),
                )
                .output(
                    CellOutput::new_builder()
                        .capacity(second_amount)
                        .lock(refund_two.clone())
                        .build(),
                );
        }
        builder = builder
            .output(
                empty_terminal
                    .as_builder()
                    .capacity(terminal_capacity)
                    .build(),
            )
            .output(
                CellOutput::new_builder()
                    .capacity(EXECUTOR_CAPACITY - FEE - mixed_capacity)
                    .lock(executor.lock)
                    .build(),
            )
            .output_data(Bytes::new().pack())
            .output_data(Bytes::new().pack())
            .output_data(terminal_campaign_data.pack())
            .output_data(Bytes::new().pack());
        if mixed_capacity > 0 {
            builder = builder
                .output(
                    CellOutput::new_builder()
                        .capacity(mixed_capacity)
                        .lock(success_recipient)
                        .build(),
                )
                .output_data(Bytes::new().pack());
        }
    } else {
        builder = builder
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
    }

    let transaction = builder
        .witness(
            execution_witness(0, 0, executor_hash, &[0, 1])
                .as_bytes()
                .pack(),
        )
        .witness(WitnessArgs::default().as_bytes().pack())
        .witness(
            WitnessArgs::new_builder()
                .input_type(Some(Bytes::from(records)).pack())
                .build()
                .as_bytes()
                .pack(),
        )
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

#[test]
fn under_target_campaign_enters_the_committed_refund_state() {
    verify(&build_success_case(Mutation::Refund)).expect("valid refund-state transition");
}

#[test]
fn refund_state_rejects_target_boundary_and_mutated_commitments() {
    assert_fails(Mutation::RefundAtTarget, 32);
    assert_fails(Mutation::RefundCommitment, 25);
    assert_fails(Mutation::RefundState, 32);
}

#[test]
fn refund_outputs_are_bound_to_committed_recipient_amount_and_order() {
    assert_fails(Mutation::RefundWrongRecipient, 32);
    assert_fails(Mutation::RefundAmount, 32);
    assert_fails(Mutation::RefundOrder, 32);
    assert_fails(Mutation::RefundMixed, 32);
}
