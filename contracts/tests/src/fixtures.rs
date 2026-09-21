use ckb_testtool::{
    ckb_hash::blake2b_256,
    ckb_types::{
        bytes::Bytes,
        core::{
            Capacity, EpochNumberWithFraction, HeaderBuilder, HeaderView, ScriptHashType,
            TransactionBuilder, TransactionView,
        },
        packed::{CellInput, CellOutput, OutPoint, Script, WitnessArgs},
        prelude::*,
    },
    context::Context,
};

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
