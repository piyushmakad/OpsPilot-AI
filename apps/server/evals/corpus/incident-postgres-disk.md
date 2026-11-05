# Runbook: PostgreSQL disk pressure

## Symptoms

API requests start failing with "could not extend file" or "No space left on device". Write latency rises sharply before the failures.

## Diagnosis

Check volume usage on the primary database node. The most common cause is write-ahead log (WAL) growth because an inactive replication slot prevents WAL files from being removed. Query pg_replication_slots and look for slots where active is false.

## Mitigation

Drop the inactive replication slot after confirming no replica still needs it, then run a checkpoint. If space is still low, expand the volume by 50 percent. Never delete files in pg_wal by hand.

## Follow-up

Add an alert when disk usage exceeds 80 percent and when any replication slot lags by more than 10 GB. Write a postmortem within 5 business days.
