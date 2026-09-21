#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(i8)]
pub enum ScriptError {
    InvalidData = 10,
    UnsupportedVersion = 11,
    ReservedFlags = 12,
    InvalidState = 13,
    UnsupportedTrigger = 14,
    InvalidWitnessMode = 15,
    MissingOwnerAuthorization = 16,
    PolicyHashMismatch = 17,
    TriggerHashMismatch = 18,
    PayloadHashMismatch = 19,
    JobIdMismatch = 20,
    SequenceMismatch = 21,
    NotYetEligible = 22,
    InvalidSince = 23,
    SuccessorCountMismatch = 24,
    SuccessorInvariantMismatch = 25,
    BudgetIncrease = 26,
    RunsIncrease = 27,
    CapacityNotConserved = 28,
    RewardAmountMismatch = 29,
    RewardRecipientMismatch = 30,
    RewardForbidden = 31,
    InvalidApplicationState = 32,
    MissingHeader = 33,
    ArithmeticOverflow = 34,
    UnsupportedRecovery = 35,
}

impl From<ScriptError> for i8 {
    fn from(error: ScriptError) -> Self {
        error as i8
    }
}
