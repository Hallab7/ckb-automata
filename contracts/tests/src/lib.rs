pub fn native_harness_ready() -> bool {
    true
}

#[allow(
    clippy::clone_on_copy,
    clippy::derivable_impls,
    clippy::if_same_then_else,
    clippy::manual_is_multiple_of,
    clippy::needless_borrow,
    clippy::write_literal
)]
pub mod generated {
    include!("../../generated/job_v1.rs");
}

#[cfg(test)]
mod tests {
    use molecule::prelude::{Builder, Entity};
    use serde::Deserialize;

    use super::{generated::JobDataV1, native_harness_ready};

    #[derive(Deserialize)]
    struct JobFixture {
        version: u16,
        flags: u16,
        job_id: String,
        sequence: String,
        state: u8,
        trigger_kind: u16,
        trigger_params_hash: String,
        policy_script_hash: String,
        payload_hash: String,
        reward: String,
        remaining_budget: String,
        not_before: String,
        not_after: String,
        remaining_runs: u32,
        cancel_lock_hash: String,
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
    fn native_harness_compiles_and_runs() {
        assert!(native_harness_ready());
    }

    #[test]
    fn rust_binding_matches_cross_language_fixture() {
        let fixture: JobFixture =
            serde_json::from_str(include_str!("../../fixtures/job_data_v1.json")).unwrap();
        let encoded = JobDataV1::new_builder()
            .version(fixture.version.to_le_bytes())
            .flags(fixture.flags.to_le_bytes())
            .job_id(byte32(&fixture.job_id))
            .sequence(fixture.sequence.parse::<u64>().unwrap().to_le_bytes())
            .state(fixture.state)
            .trigger_kind(fixture.trigger_kind.to_le_bytes())
            .trigger_params_hash(byte32(&fixture.trigger_params_hash))
            .policy_script_hash(byte32(&fixture.policy_script_hash))
            .payload_hash(byte32(&fixture.payload_hash))
            .reward(fixture.reward.parse::<u64>().unwrap().to_le_bytes())
            .remaining_budget(
                fixture
                    .remaining_budget
                    .parse::<u64>()
                    .unwrap()
                    .to_le_bytes(),
            )
            .not_before(fixture.not_before.parse::<u64>().unwrap().to_le_bytes())
            .not_after(fixture.not_after.parse::<u64>().unwrap().to_le_bytes())
            .remaining_runs(fixture.remaining_runs.to_le_bytes())
            .cancel_lock_hash(byte32(&fixture.cancel_lock_hash))
            .build();

        assert_eq!(encoded.as_slice(), decode_hex(&fixture.expected_hex));
    }
}
