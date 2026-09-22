use ckb_testtool::{
    ckb_types::{
        bytes::Bytes,
        core::{ScriptHashType, TransactionBuilder},
        packed::{CellInput, CellOutput},
        prelude::*,
    },
    context::Context,
};

use crate::fixtures::contract_binary;

fn verify_lock(args: Bytes) -> Result<(), String> {
    let mut context = Context::new_with_deterministic_rng();
    let code = context.deploy_cell(contract_binary("campaign-lock"));
    let lock = context
        .build_script_with_hash_type(&code, ScriptHashType::Data1, args)
        .expect("campaign lock");
    let input = context.create_cell(
        CellOutput::new_builder()
            .capacity(10_000_000_000_u64)
            .lock(lock.clone())
            .build(),
        Bytes::new(),
    );
    let transaction = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(input).build())
        .output(
            CellOutput::new_builder()
                .capacity(10_000_000_000_u64)
                .lock(lock)
                .build(),
        )
        .output_data(Bytes::new().pack())
        .build();
    let transaction = context.complete_tx(transaction);
    context
        .verify_tx(&transaction, 1_000_000)
        .map(|_| ())
        .map_err(|error| format!("{error:?}"))
}

#[test]
fn empty_args_allow_permissionless_campaign_consumption() {
    verify_lock(Bytes::new()).expect("empty campaign lock args");
}

#[test]
fn nonempty_args_are_rejected() {
    let error = verify_lock(Bytes::from(vec![1])).expect_err("nonempty args must fail");
    assert!(error.contains("10"), "unexpected error: {error}");
}
