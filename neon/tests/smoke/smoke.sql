\set ON_ERROR_STOP on
SELECT version(), current_database();
BEGIN;
CREATE TABLE qualification_test (id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL,created_at TIMESTAMPTZ DEFAULT now());
INSERT INTO qualification_test(name) VALUES ('klustr-test-1'),('klustr-test-2');
DO $$ BEGIN ASSERT (SELECT count(*)=2 FROM qualification_test); END $$;
SAVEPOINT rollback_test;
INSERT INTO qualification_test(name) VALUES ('transaction-test');
ROLLBACK TO rollback_test;
DO $$ BEGIN ASSERT (SELECT count(*)=2 FROM qualification_test); END $$;
DROP TABLE qualification_test;
COMMIT;
