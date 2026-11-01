# Chapter 84 — choosing the structure

```text
$ go test -run TestLRU -v ./internal/dsa
=== RUN   TestLRUEvictsLeastRecentlyUsed
--- PASS: TestLRUEvictsLeastRecentlyUsed (0.00s)
PASS
ok  	todo/internal/dsa	0.004s

$ go test -run '^$' -bench BenchmarkLRUGet -benchmem ./internal/dsa
goos: linux
goarch: amd64
pkg: todo/internal/dsa
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
BenchmarkLRUGet-16    	28035411	        39.81 ns/op	       0 B/op	       0 allocs/op
PASS
ok  	todo/internal/dsa	1.194s
```
