# Chapter 76 — cost, measured

```text
$ go test -run '^$' -bench 'Benchmark(Slice|Map)Contains' -benchmem ./internal/dsa
goos: linux
goarch: amd64
pkg: todo/internal/dsa
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
BenchmarkSliceContains-16    	  341961	      4598 ns/op	       0 B/op	       0 allocs/op
BenchmarkMapContains-16      	120690066	        11.09 ns/op	       0 B/op	       0 allocs/op
PASS
ok  	todo/internal/dsa	3.961s
```
