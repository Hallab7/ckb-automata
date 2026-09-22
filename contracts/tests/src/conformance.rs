use molecule::prelude::Entity;
use serde::Deserialize;

use crate::generated::JobDataV1;

#[derive(Deserialize)]
struct Fixture {
    version: u8,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    id: String,
    policy: String,
    json: JsonView,
    binary: String,
    transaction: String,
    expected: Expected,
}

#[derive(Deserialize)]
struct JsonView {
    job_id: String,
    sequence: String,
    remaining_runs: String,
    policy: String,
}

#[derive(Deserialize)]
struct Expected {
    json_matches_binary: bool,
    binary_status: String,
    transaction_valid: bool,
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    let digits = value.strip_prefix("0x")?;
    if digits.len() % 2 != 0 {
        return None;
    }
    (0..digits.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&digits[index..index + 2], 16).ok())
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    let mut value = String::from("0x");
    for byte in bytes {
        value.push_str(&format!("{byte:02x}"));
    }
    value
}

fn u16_le(bytes: &[u8]) -> u16 {
    u16::from_le_bytes(bytes.try_into().expect("Molecule Uint16"))
}

fn u32_le(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes.try_into().expect("Molecule Uint32"))
}

fn u64_le(bytes: &[u8]) -> u64 {
    u64::from_le_bytes(bytes.try_into().expect("Molecule Uint64"))
}

fn binary_status(binary: &[u8]) -> (&'static str, Option<JobDataV1>) {
    match JobDataV1::from_slice(binary) {
        Err(_) => ("malformed", None),
        Ok(job) if u16_le(job.version().as_slice()) != 1 => ("unsupported_version", Some(job)),
        Ok(job)
            if u16_le(job.flags().as_slice()) != 0
                || job.state().as_slice() != [0]
                || !(1..=6).contains(&u16_le(job.trigger_kind().as_slice()))
                || u32_le(job.remaining_runs().as_slice()) == 0 =>
        {
            ("invalid_job", Some(job))
        }
        Ok(job) => ("ok", Some(job)),
    }
}

fn transaction_valid(transaction: &[u8], binary: &[u8]) -> bool {
    if transaction.len() < 4 || binary.is_empty() {
        return false;
    }
    let declared = u32::from_le_bytes(transaction[..4].try_into().unwrap()) as usize;
    declared == transaction.len()
        && transaction
            .windows(binary.len())
            .any(|value| value == binary)
}

#[test]
fn contracts_consume_the_canonical_sdk_conformance_suite() {
    let fixture: Fixture =
        serde_json::from_str(include_str!("../../fixtures/sdk_conformance_v1.json")).unwrap();
    assert_eq!(fixture.version, 1);
    assert_eq!(fixture.cases.len(), 5);

    let mut json_results = Vec::new();
    let mut binary_results = Vec::new();
    let mut transaction_results = Vec::new();
    for case in fixture.cases {
        let binary = decode_hex(&case.binary).unwrap_or_default();
        let transaction = decode_hex(&case.transaction).unwrap_or_default();
        let (status, job) = binary_status(&binary);
        let json_matches = job.is_some_and(|job| {
            case.json.job_id == hex(job.job_id().as_slice())
                && case.json.sequence == u64_le(job.sequence().as_slice()).to_string()
                && case.json.remaining_runs == u32_le(job.remaining_runs().as_slice()).to_string()
                && case.json.policy == case.policy
                && status == "ok"
        });
        let transaction_matches = transaction_valid(&transaction, &binary);
        assert_eq!(
            json_matches, case.expected.json_matches_binary,
            "{} JSON drifted",
            case.id
        );
        assert_eq!(
            status, case.expected.binary_status,
            "{} binary drifted",
            case.id
        );
        assert_eq!(
            transaction_matches, case.expected.transaction_valid,
            "{} transaction drifted",
            case.id
        );
        json_results.push(json_matches);
        binary_results.push(status == "ok");
        transaction_results.push(transaction_matches);
    }

    for results in [json_results, binary_results, transaction_results] {
        assert!(results.contains(&true));
        assert!(results.contains(&false));
    }
}
