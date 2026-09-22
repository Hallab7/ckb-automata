pub fn matches_plain_output(
    actual_lock_hash: &[u8; 32],
    expected_lock_hash: &[u8; 32],
    actual_capacity: u64,
    expected_capacity: u64,
    has_type_script: bool,
    data_is_empty: bool,
) -> bool {
    actual_lock_hash == expected_lock_hash
        && actual_capacity == expected_capacity
        && !has_type_script
        && data_is_empty
}
