use ckb_hash::new_blake2b;

const MAX_ABSOLUTE_BLOCK_NUMBER: u64 = (1 << 56) - 1;
const REFUND_DOMAIN: &[u8] = b"ckb-automata/campaign-refunds/v1";
pub const PLEDGE_RECORD_SIZE: usize = 76;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum CampaignStateMarker {
    Succeeded = 1,
    Refunding = 2,
}

pub fn determine_campaign_outcome(
    pledged: u64,
    target: u64,
) -> Option<CampaignStateMarker> {
    if target == 0 {
        return None;
    }
    Some(if pledged >= target {
        CampaignStateMarker::Succeeded
    } else {
        CampaignStateMarker::Refunding
    })
}

pub fn is_absolute_block_deadline(deadline_since: u64) -> bool {
    deadline_since > 0 && deadline_since <= MAX_ABSOLUTE_BLOCK_NUMBER
}

pub fn refund_commitment(pledge_count: u32, records: &[u8]) -> [u8; 32] {
    let body_length = 4_usize
        .checked_add(records.len())
        .expect("refund commitment body length");
    let mut hasher = new_blake2b();
    hasher.update(REFUND_DOMAIN);
    hasher.update(&[0]);
    hasher.update(&(body_length as u32).to_le_bytes());
    hasher.update(&pledge_count.to_le_bytes());
    hasher.update(records);
    let mut result = [0_u8; 32];
    hasher.finalize(&mut result);
    result
}

pub fn validate_refund_records(
    records: &[u8],
    pledge_count: u32,
    pledged: u64,
    expected_commitment: &[u8],
) -> bool {
    if records.len() != pledge_count as usize * PLEDGE_RECORD_SIZE
        || expected_commitment.len() != 32
    {
        return false;
    }

    let mut sum = 0_u64;
    let mut previous_out_point: Option<([u8; 32], u32)> = None;
    for record in records.chunks_exact(PLEDGE_RECORD_SIZE) {
        let mut transaction_hash = [0_u8; 32];
        transaction_hash.copy_from_slice(&record[..32]);
        let output_index = u32::from_le_bytes(record[32..36].try_into().expect("pledge index"));
        if let Some((previous_hash, previous_index)) = previous_out_point
            && (transaction_hash < previous_hash
                || (transaction_hash == previous_hash && output_index <= previous_index))
        {
            return false;
        }
        if record[36..68].iter().all(|byte| *byte == 0) {
            return false;
        }
        let amount = u64::from_le_bytes(record[68..76].try_into().expect("pledge amount"));
        if amount == 0 {
            return false;
        }
        let Some(next_sum) = sum.checked_add(amount) else {
            return false;
        };
        sum = next_sum;
        previous_out_point = Some((transaction_hash, output_index));
    }

    sum == pledged && refund_commitment(pledge_count, records) == expected_commitment
}
