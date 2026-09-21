pub fn native_harness_ready() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::native_harness_ready;

    #[test]
    fn native_harness_compiles_and_runs() {
        assert!(native_harness_ready());
    }
}
