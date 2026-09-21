use molecule::prelude::{Builder, Entity};
use serde::Deserialize;

use crate::{
    campaign::{CampaignStateMarker, determine_campaign_outcome, is_absolute_block_deadline},
    generated_campaign::CampaignDataV1,
};

#[derive(Deserialize)]
struct CampaignFixture {
    version: u16,
    state: u8,
    campaign_id: String,
    pledged: String,
    pledge_count: u32,
    target: String,
    deadline_since: String,
    success_lock_hash: String,
    refund_commitment: String,
    expected_hex: String,
}

fn decode_hex(value: &str) -> Vec<u8> {
    let digits = value.strip_prefix("0x").unwrap_or(value);
    assert_eq!(digits.len() % 2, 0, "hex value has an odd length");
    (0..digits.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&digits[index..index + 2], 16).unwrap())
        .collect()
}

fn byte32(value: &str) -> [u8; 32] {
    decode_hex(value)
        .try_into()
        .expect("fixture must contain 32 bytes")
}

#[test]
fn rust_campaign_binding_matches_cross_language_fixture() {
    let fixture: CampaignFixture =
        serde_json::from_str(include_str!("../../fixtures/campaign_data_v1.json")).unwrap();
    let encoded = CampaignDataV1::new_builder()
        .version(fixture.version.to_le_bytes())
        .state(fixture.state)
        .campaign_id(byte32(&fixture.campaign_id))
        .pledged(fixture.pledged.parse::<u64>().unwrap().to_le_bytes())
        .pledge_count(fixture.pledge_count.to_le_bytes())
        .target(fixture.target.parse::<u64>().unwrap().to_le_bytes())
        .deadline_since(fixture.deadline_since.parse::<u64>().unwrap().to_le_bytes())
        .success_lock_hash(byte32(&fixture.success_lock_hash))
        .refund_commitment(byte32(&fixture.refund_commitment))
        .build();

    assert_eq!(encoded.as_slice(), decode_hex(&fixture.expected_hex));
}

#[test]
fn outcome_boundary_is_objective() {
    assert_eq!(
        determine_campaign_outcome(99, 100),
        Some(CampaignStateMarker::Refunding)
    );
    assert_eq!(
        determine_campaign_outcome(100, 100),
        Some(CampaignStateMarker::Succeeded)
    );
    assert_eq!(
        determine_campaign_outcome(101, 100),
        Some(CampaignStateMarker::Succeeded)
    );
    assert_eq!(determine_campaign_outcome(0, 0), None);
    assert!(!is_absolute_block_deadline(0));
    assert!(is_absolute_block_deadline(1));
    assert!(is_absolute_block_deadline((1 << 56) - 1));
    assert!(!is_absolute_block_deadline(1 << 56));
}
