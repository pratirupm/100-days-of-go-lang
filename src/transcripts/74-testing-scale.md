# Chapter 74 — testing the system

```text
$ go test -race -count=1 -v ./internal/activity
=== RUN   TestListNewestFirstAndLimit
--- PASS: TestListNewestFirstAndLimit (0.00s)
=== RUN   TestAddDeduplicatesByID
--- PASS: TestAddDeduplicatesByID (0.00s)
=== RUN   TestJSONContract
--- PASS: TestJSONContract (0.00s)
PASS
ok  	todo/internal/activity	1.013s
```
