use ckb_hash::new_blake2b;

const JOB_ID_DOMAIN: &[u8] = b"ckb-automata/job-id/v1";

pub enum CreationAnchor<'a> {
    OutputIndex(u64),
    TypeId(&'a [u8; 32]),
}

pub fn derive_job_id(
    genesis_hash: &[u8; 32],
    protocol_version: u16,
    creation_commitment: &[u8; 32],
    anchor: CreationAnchor<'_>,
    creator_nonce: u64,
    policy_script_hash: &[u8; 32],
) -> [u8; 32] {
    let anchor_length = match anchor {
        CreationAnchor::OutputIndex(_) => 8,
        CreationAnchor::TypeId(_) => 32,
    };
    let body_length = 32 + 2 + 32 + 1 + anchor_length + 8 + 32;
    let mut hasher = new_blake2b();
    hasher.update(JOB_ID_DOMAIN);
    hasher.update(&[0]);
    hasher.update(&(body_length as u32).to_le_bytes());
    hasher.update(genesis_hash);
    hasher.update(&protocol_version.to_le_bytes());
    hasher.update(creation_commitment);
    match anchor {
        CreationAnchor::OutputIndex(output_index) => {
            hasher.update(&[0]);
            hasher.update(&output_index.to_le_bytes());
        }
        CreationAnchor::TypeId(type_id) => {
            hasher.update(&[1]);
            hasher.update(type_id);
        }
    }
    hasher.update(&creator_nonce.to_le_bytes());
    hasher.update(policy_script_hash);

    let mut result = [0_u8; 32];
    hasher.finalize(&mut result);
    result
}
