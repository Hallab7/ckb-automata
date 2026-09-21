pub const NATIVE_HARNESS_READY: bool = true;

#[cfg(test)]
mod tests {
    use super::NATIVE_HARNESS_READY;

    #[test]
    fn native_harness_compiles_and_runs() {
        assert!(NATIVE_HARNESS_READY);
    }
}
