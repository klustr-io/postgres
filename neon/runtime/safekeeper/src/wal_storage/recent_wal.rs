//! A bounded comparison window of bytes already written by this resident store.
//! It proves duplicate identity only. It never supplies a durable LSN, repairs
//! storage, or survives truncation/restart. Uncovered ranges use normal reads.

const CAPACITY: usize = 64 * 1024;

pub(super) struct RecentWal {
    bytes: Vec<u8>,
    begin: u64,
    end: u64,
    valid: bool,
}

impl RecentWal {
    pub(super) fn new() -> Self {
        Self {
            bytes: vec![0; CAPACITY],
            begin: 0,
            end: 0,
            valid: false,
        }
    }

    pub(super) fn remember(&mut self, start: u64, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        let Some(end) = start.checked_add(data.len() as u64) else {
            self.valid = false;
            return;
        };
        if !self.valid || self.end != start {
            self.begin = start;
        }
        let length = data.len().min(CAPACITY);
        let retained = &data[data.len() - length..];
        let offset = ((end - length as u64) % CAPACITY as u64) as usize;
        let first = length.min(CAPACITY - offset);
        self.bytes[offset..offset + first].copy_from_slice(&retained[..first]);
        self.bytes[..length - first].copy_from_slice(&retained[first..]);
        self.end = end;
        self.begin = self.begin.max(end.saturating_sub(CAPACITY as u64));
        self.valid = true;
    }

    pub(super) fn matches(&self, start: u64, data: &[u8]) -> Option<bool> {
        let end = start.checked_add(data.len() as u64)?;
        if !self.valid || start < self.begin || end > self.end {
            return None;
        }
        let offset = (start % CAPACITY as u64) as usize;
        let first = data.len().min(CAPACITY - offset);
        Some(
            self.bytes[offset..offset + first] == data[..first]
                && self.bytes[..data.len() - first] == data[first..],
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verifies_wrapped_bytes_and_rejects_changed_content() {
        let mut window = RecentWal::new();
        window.remember(100, &vec![1; 60000]);
        window.remember(60100, &vec![2; 20000]);
        assert_eq!(window.matches(14564, &[1; 100]), Some(true));
        assert_eq!(window.matches(14563, &[1]), None);
        let mut crossing = vec![1; 10];
        crossing.extend_from_slice(&[2; 20]);
        assert_eq!(window.matches(60090, &crossing), Some(true));
        crossing[20] = 3;
        assert_eq!(window.matches(60090, &crossing), Some(false));
        assert_eq!(window.matches(80100, &[2]), None);
    }
    #[test]
    fn retains_only_the_bounded_suffix() {
        let mut window = RecentWal::new();
        let data: Vec<_> = (0..2 * CAPACITY + 13).map(|i| (i % 251) as u8).collect();
        window.remember(0, &data);
        let begin = data.len() - CAPACITY;
        assert_eq!(window.matches(begin as u64, &data[begin..]), Some(true));
        assert_eq!(
            window.matches((begin - 1) as u64, &data[begin - 1..begin]),
            None
        );
    }
    #[test]
    fn discontinuity_and_overflow_discard_old_identity() {
        let mut window = RecentWal::new();
        window.remember(100, b"first");
        window.remember(200, b"next");
        assert_eq!(window.matches(100, b"first"), None);
        assert_eq!(window.matches(200, b"next"), Some(true));
        window.remember(u64::MAX, b"overflow");
        assert_eq!(window.matches(200, b"next"), None);
    }
}
