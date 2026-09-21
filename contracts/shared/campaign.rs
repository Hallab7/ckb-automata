const MAX_ABSOLUTE_BLOCK_NUMBER: u64 = (1 << 56) - 1;

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
