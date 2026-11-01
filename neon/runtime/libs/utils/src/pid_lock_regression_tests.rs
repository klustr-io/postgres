use super::*;

#[test]
fn failed_claim_preserves_live_owner_contents() {
    let directory = camino_tempfile::tempdir().unwrap();
    let path = directory.path().join("owner.pid");
    let owner = create_exclusive(&path)
        .unwrap()
        .write_content("123456".to_owned())
        .unwrap();
    assert!(create_exclusive(&path).is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "123456");
    match read_and_hold_lock_file(&path).unwrap() {
        LockFileRead::LockedByOtherProcess { content, .. } => assert_eq!(content, "123456"),
        _ => panic!("Failed contender must not release the live owner's lock"),
    }
    drop(owner);
    let replacement = create_exclusive(&path)
        .unwrap()
        .write_content("7".to_owned())
        .unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "7");
    drop(replacement);
}

#[test]
fn duplicate_pid_claim_keeps_existing_owner_discoverable() {
    let directory = camino_tempfile::tempdir().unwrap();
    let path = directory.path().join("process.pid");
    let owner = crate::pid_file::claim_for_current_process(&path).unwrap();
    assert!(crate::pid_file::claim_for_current_process(&path).is_err());
    match crate::pid_file::read(&path).unwrap() {
        crate::pid_file::PidFileRead::LockedByOtherProcess(pid) => {
            assert_eq!(pid, nix::unistd::Pid::this());
        }
        _ => panic!("The active owner must remain discoverable after a rejected duplicate claim"),
    }
    drop(owner);
}
