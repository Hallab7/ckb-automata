pub const MAX_CONTROLLED_OUTPUTS: usize = 16;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExecutionRequest {
    pub reward_output_index: usize,
    pub executor_lock_hash: [u8; 32],
    pub controlled_output_count: usize,
    pub controlled_output_indices: [usize; MAX_CONTROLLED_OUTPUTS],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WitnessOperation {
    Execute(ExecutionRequest),
    Cancel,
    Recover,
    TopUp { successor_output_index: usize },
}

pub fn parse_witness_operation(bytes: &[u8]) -> Option<WitnessOperation> {
    match bytes {
        [1] => Some(WitnessOperation::Cancel),
        [2] => Some(WitnessOperation::Recover),
        [3, index @ ..] if index.len() == 4 => Some(WitnessOperation::TopUp {
            successor_output_index: read_u32(index) as usize,
        }),
        execution if execution.len() >= 38 && execution[0] == 0 => {
            let controlled_output_count = execution[37] as usize;
            if controlled_output_count == 0
                || controlled_output_count > MAX_CONTROLLED_OUTPUTS
                || execution.len() != 38 + controlled_output_count * 4
            {
                return None;
            }
            let mut executor_lock_hash = [0_u8; 32];
            executor_lock_hash.copy_from_slice(&execution[5..37]);
            let mut controlled_output_indices = [0_usize; MAX_CONTROLLED_OUTPUTS];
            for (position, chunk) in execution[38..].chunks_exact(4).enumerate() {
                controlled_output_indices[position] = read_u32(chunk) as usize;
            }
            let controlled = &controlled_output_indices[..controlled_output_count];
            if controlled
                .iter()
                .enumerate()
                .any(|(position, index)| controlled[..position].contains(index))
            {
                return None;
            }
            Some(WitnessOperation::Execute(ExecutionRequest {
                reward_output_index: read_u32(&execution[1..5]) as usize,
                executor_lock_hash,
                controlled_output_count,
                controlled_output_indices,
            }))
        }
        _ => None,
    }
}

fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes.try_into().expect("four-byte witness field"))
}
