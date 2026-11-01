# Chapter 72 — retries, idempotency, ordering

```text
$ go test -count=1 -v ./internal/retry
=== RUN   TestDoSucceedsAfterTransientFailures
--- PASS: TestDoSucceedsAfterTransientFailures (0.00s)
=== RUN   TestDoStopsOnPermanent
--- PASS: TestDoStopsOnPermanent (0.00s)
=== RUN   TestDoStopsWhenContextEnds
--- PASS: TestDoStopsWhenContextEnds (0.00s)
PASS
ok  	todo/internal/retry	0.005s
```
