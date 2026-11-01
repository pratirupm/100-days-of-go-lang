# Chapter 51 — the app in a box

```text
$ podman build -f deploy/Dockerfile.dev -t todo:dev .
...
Successfully tagged localhost/todo:dev

$ podman run -d --name todo-pilot -p 8080:8080 -v todo-data:/data todo:dev
d48e867014320e90e13d24bd82bd1e04eb06ba802d7376425a78bce2253d0a06

$ curl -sS -i http://127.0.0.1:8080/ready
HTTP/1.1 200 OK
Content-Type: application/json
...
{"status":"ok"}

$ podman run --name todo-base -p 8080:8080 todo:base
panic: unable to load turso library: failed to load library from path /tmp/turso-go/turso-go/fb4685f8/libturso_sync_sdk_kit.so: libgcc_s.so.1: cannot open shared object file: No such file or directory
...
```
