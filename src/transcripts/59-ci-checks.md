# Chapter 59 — checks on every change

```text
$ actionlint .github/workflows/ci.yml
...
$ podman build -f deploy/Dockerfile.dev -t todo:ci .
...
Successfully tagged localhost/todo:ci

$ podman run -d --name todo-ci -p 18085:8080 -e TODO_ADMIN_EMAIL=admin@example.com -e TODO_ADMIN_KEY=ci-admin-key todo:ci
78c55aebadccf23c507c1005b7ebf97ee144b162f193a336429c0efba665299e

$ curl -sS http://127.0.0.1:18085/ready
{"status":"ok"}
```
