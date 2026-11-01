# Chapter 77 — slices and maps, underneath

```text
$ go test -run TestDynamicArray -v ./internal/dsa
=== RUN   TestDynamicArrayGrowsAndReads
--- PASS: TestDynamicArrayGrowsAndReads (0.00s)
PASS
ok  	todo/internal/dsa	0.002s

$ go test -run '^$' -bench 'BenchmarkAppend' -benchmem ./internal/dsa
goos: linux
goarch: amd64
pkg: todo/internal/dsa
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
BenchmarkAppendGrow-16        	  166503	      7338 ns/op	   25208 B/op	      12 allocs/op
BenchmarkAppendPrealloc-16    	  473226	      2882 ns/op	    8192 B/op	       1 allocs/op
PASS
ok  	todo/internal/dsa	2.693s
```
