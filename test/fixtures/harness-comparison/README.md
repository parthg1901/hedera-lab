# Frozen evaluation seed

This is the pre-stress-fix ticket service used to register the September 6 Harness
comparison. It intentionally preserves the lost-HCS-response duplication bug found
by the later exploratory stress test. It is test data, not the working example.

The comparison runner derives controlled missing-association, fake-attendance and
lost-transfer-response defects from this file and records each resulting hash
before model execution. Keeping it frozen prevents subsequent example fixes from
silently changing the benchmark tasks. `test/ticket-stress.test.mjs` also reproduces
the historical HCS bug against it.
