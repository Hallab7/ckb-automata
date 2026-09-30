pub const AUTOMATION_MODE: u8 = 0;
pub const OWNER_MODE: u8 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VaultOperation {
    Prepare { job_input_index: usize },
    Roll { job_input_index: usize },
    OwnerStop,
    OwnerExit,
    OwnerRecover,
}

pub fn parse_vault_operation(bytes: &[u8]) -> Option<VaultOperation> {
    match bytes {
        [AUTOMATION_MODE, 0, rest @ ..] if rest.len() == 4 => Some(VaultOperation::Prepare {
            job_input_index: read_u32(rest)? as usize,
        }),
        [AUTOMATION_MODE, 1, rest @ ..] if rest.len() == 4 => Some(VaultOperation::Roll {
            job_input_index: read_u32(rest)? as usize,
        }),
        [OWNER_MODE, 2] => Some(VaultOperation::OwnerStop),
        [OWNER_MODE, 3] => Some(VaultOperation::OwnerExit),
        [OWNER_MODE, 4] => Some(VaultOperation::OwnerRecover),
        _ => None,
    }
}

fn read_u32(bytes: &[u8]) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.try_into().ok()?))
}
