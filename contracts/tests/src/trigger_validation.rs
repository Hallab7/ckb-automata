use crate::trigger::{
    absolute_since_is_satisfied, absolute_since_strictly_advances, decode_absolute_since,
    validate_trigger_since,
};

const RELATIVE: u64 = 1 << 63;
const EPOCH: u64 = 0b01 << 61;
const TIMESTAMP: u64 = 0b10 << 61;

fn epoch(number: u64, index: u64, length: u64) -> u64 {
    EPOCH | number | (index << 24) | (length << 40)
}

#[test]
fn block_boundary_is_closed_at_the_committed_height() {
    let committed = 42;
    assert_eq!(absolute_since_is_satisfied(committed, 41), Some(false));
    assert_eq!(absolute_since_is_satisfied(committed, 42), Some(true));
    assert_eq!(absolute_since_is_satisfied(committed, 43), Some(true));
    assert!(validate_trigger_since(1, committed, committed));
}

#[test]
fn epoch_boundary_compares_the_fraction_without_rounding() {
    let committed = epoch(12, 2, 10);
    assert_eq!(
        absolute_since_is_satisfied(committed, epoch(12, 1, 10)),
        Some(false)
    );
    assert_eq!(
        absolute_since_is_satisfied(committed, epoch(12, 2, 10)),
        Some(true)
    );
    assert_eq!(
        absolute_since_is_satisfied(committed, epoch(12, 3, 10)),
        Some(true)
    );
    assert!(validate_trigger_since(2, committed, committed));
    assert!(absolute_since_strictly_advances(
        epoch(12, 2, 10),
        epoch(12, 1, 4)
    ));
    assert!(!absolute_since_strictly_advances(
        epoch(12, 1, 4),
        epoch(12, 2, 10)
    ));
}

#[test]
fn timestamp_boundary_is_closed_at_the_committed_value() {
    let value = 1_700_000_000;
    let committed = TIMESTAMP | value;
    assert_eq!(
        absolute_since_is_satisfied(committed, value - 1),
        Some(false)
    );
    assert_eq!(absolute_since_is_satisfied(committed, value), Some(true));
    assert_eq!(
        absolute_since_is_satisfied(committed, value + 1),
        Some(true)
    );
    assert!(validate_trigger_since(3, committed, committed));
}

#[test]
fn noncanonical_and_unsupported_since_values_are_rejected() {
    assert!(decode_absolute_since(RELATIVE | 42).is_none());
    assert!(decode_absolute_since(1 << 56).is_none());
    assert!(decode_absolute_since(0b11 << 61).is_none());
    assert!(decode_absolute_since(epoch(12, 10, 10)).is_none());
    assert!(!validate_trigger_since(1, 42, 41));
    assert!(!validate_trigger_since(1, EPOCH | 42, EPOCH | 42));
    assert!(!validate_trigger_since(2, 42, 42));
    assert!(!validate_trigger_since(3, 42, 42));
}

#[test]
fn event_driven_triggers_cannot_hide_a_time_lock() {
    for trigger_kind in 4..=6 {
        assert!(validate_trigger_since(trigger_kind, 0, 0));
        assert!(!validate_trigger_since(trigger_kind, 1, 1));
    }
}
