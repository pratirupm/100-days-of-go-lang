# Chapter 52 — two containers, one command

```text
$ podman compose up -d --build
...
 Container go-todo-app-app-1 Started
 Container go-todo-app-proxy-1 Started

$ podman compose ps --format 'table {{.Name}}\t{{.Service}}\t{{.Status}}'
NAME                  SERVICE   STATUS
go-todo-app-app-1     app       Up 22 seconds
go-todo-app-proxy-1   proxy     Up 6 seconds

$ curl -sS -i http://127.0.0.1:8081/ready
HTTP/1.1 200 OK
Content-Type: application/json
Via: 1.1 Caddy
...
{"status":"ok"}

$ podman compose down
```
