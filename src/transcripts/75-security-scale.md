# Chapter 75 — security at scale

```text
$ make vulncheck
No vulnerabilities found.

Your code is affected by 0 vulnerabilities.
This scan also found 0 vulnerabilities in packages you import and 3
vulnerabilities in modules you require, but your code doesn't appear to call
these vulnerabilities.
Use '-show verbose' for more details.

$ make leaks
...
3:23PM INF 324 commits scanned.
3:23PM INF scanned ~4073157 bytes (4.07 MB) in 591ms
3:23PM INF no leaks found

$ go test ./internal/audit
ok  	todo/internal/audit
```
