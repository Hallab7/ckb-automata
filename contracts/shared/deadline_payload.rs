use ckb_hash::new_blake2b;

const POLICY_PAYLOAD_DOMAIN: &[u8] = b"ckb-automata/policy-payload/v1";
const DEADLINE_CAMPAIGN_PAYLOAD_VERSION: u8 = 1;

pub fn deadline_campaign_payload_hash(
    policy_script_hash: &[u8; 32],
    campaign_type_hash: &[u8; 32],
    campaign_out_point: &[u8; 36],
) -> [u8; 32] {
    let body_length = policy_script_hash.len()
        + 1
        + campaign_type_hash.len()
        + campaign_out_point.len();
    let mut hasher = new_blake2b();
    hasher.update(POLICY_PAYLOAD_DOMAIN);
    hasher.update(&[0]);
    hasher.update(&(body_length as u32).to_le_bytes());
    hasher.update(policy_script_hash);
    hasher.update(&[DEADLINE_CAMPAIGN_PAYLOAD_VERSION]);
    hasher.update(campaign_type_hash);
    hasher.update(campaign_out_point);
    let mut result = [0_u8; 32];
    hasher.finalize(&mut result);
    result
}
