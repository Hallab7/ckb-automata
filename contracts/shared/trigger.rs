const RELATIVE_FLAG: u64 = 1 << 63;
const METRIC_MASK: u64 = 0b11 << 61;
const RESERVED_MASK: u64 = 0b1_1111 << 56;
const VALUE_MASK: u64 = (1 << 56) - 1;
const EPOCH_METRIC: u64 = 0b01 << 61;
const TIMESTAMP_METRIC: u64 = 0b10 << 61;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SinceMetric {
    Block,
    Epoch {
        number: u64,
        index: u64,
        length: u64,
    },
    Timestamp,
}

pub fn decode_absolute_since(raw: u64) -> Option<(SinceMetric, u64)> {
    if raw & (RELATIVE_FLAG | RESERVED_MASK) != 0 {
        return None;
    }

    let value = raw & VALUE_MASK;
    let metric = match raw & METRIC_MASK {
        0 => SinceMetric::Block,
        EPOCH_METRIC => {
            let number = value & 0x00ff_ffff;
            let index = (value >> 24) & 0xffff;
            let length = (value >> 40) & 0xffff;
            if length == 0 {
                if index != 0 {
                    return None;
                }
            } else if index >= length {
                return None;
            }
            SinceMetric::Epoch {
                number,
                index,
                length,
            }
        }
        TIMESTAMP_METRIC => SinceMetric::Timestamp,
        _ => return None,
    };
    Some((metric, value))
}

pub fn validate_trigger_since(trigger_kind: u16, committed: u64, actual: u64) -> bool {
    if committed != actual {
        return false;
    }

    matches!(
        (trigger_kind, decode_absolute_since(committed)),
        (1, Some((SinceMetric::Block, _)))
            | (2, Some((SinceMetric::Epoch { .. }, _)))
            | (3, Some((SinceMetric::Timestamp, _)))
            | (4..=6, Some((SinceMetric::Block, 0)))
    )
}

pub fn absolute_since_strictly_advances(previous: u64, next: u64) -> bool {
    let Some((previous_metric, previous_value)) = decode_absolute_since(previous) else {
        return false;
    };
    let Some((next_metric, next_value)) = decode_absolute_since(next) else {
        return false;
    };

    match (previous_metric, next_metric) {
        (SinceMetric::Block, SinceMetric::Block)
        | (SinceMetric::Timestamp, SinceMetric::Timestamp) => next_value > previous_value,
        (
            SinceMetric::Epoch {
                number: previous_number,
                index: previous_index,
                length: previous_length,
            },
            SinceMetric::Epoch {
                number: next_number,
                index: next_index,
                length: next_length,
            },
        ) => {
            let previous_length = if previous_length == 0 {
                1
            } else {
                previous_length
            };
            let next_length = if next_length == 0 { 1 } else { next_length };
            next_number > previous_number
                || (next_number == previous_number
                    && next_index * previous_length > previous_index * next_length)
        }
        _ => false,
    }
}

#[allow(dead_code)]
pub fn absolute_since_is_satisfied(raw: u64, target_value: u64) -> Option<bool> {
    let (metric, value) = decode_absolute_since(raw)?;
    let target = target_value & VALUE_MASK;
    match metric {
        SinceMetric::Block | SinceMetric::Timestamp => Some(target >= value),
        SinceMetric::Epoch {
            number,
            index,
            length,
        } => {
            let target_number = target & 0x00ff_ffff;
            let target_index = (target >> 24) & 0xffff;
            let target_length = (target >> 40) & 0xffff;
            if target_length == 0 {
                if target_index != 0 {
                    return None;
                }
            } else if target_index >= target_length {
                return None;
            }

            let length = if length == 0 { 1 } else { length };
            let target_length = if target_length == 0 {
                1
            } else {
                target_length
            };
            Some(
                target_number > number
                    || (target_number == number
                        && target_index * length >= index * target_length),
            )
        }
    }
}
