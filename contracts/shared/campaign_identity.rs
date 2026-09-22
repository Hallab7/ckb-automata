use ckb_hash::new_blake2b;

const CAMPAIGN_ID_DOMAIN: &[u8] = b"ckb-automata/campaign-id/v1";

pub fn derive_campaign_id(anchor_out_point: &[u8; 36], output_index: u32) -> [u8; 32] {
    let body_length = anchor_out_point.len() + core::mem::size_of::<u32>();
    let mut hasher = new_blake2b();
    hasher.update(CAMPAIGN_ID_DOMAIN);
    hasher.update(&[0]);
    hasher.update(&(body_length as u32).to_le_bytes());
    hasher.update(anchor_out_point);
    hasher.update(&output_index.to_le_bytes());

    let mut result = [0_u8; 32];
    hasher.finalize(&mut result);
    result
}
