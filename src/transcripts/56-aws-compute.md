# Chapter 56 — onto the cloud

```text
$ aws cloudformation validate-template --template-body file://deploy/aws/stack.yaml
{
    "Parameters": [
...
    ],
    "Description": "The todo server as an ECS Fargate service."
}

$ podman run -d --name todo-aws-shape -p 18083:8080 -e TODO_LISTEN=:8080 -e TODO_DB=/data/todo.db -e TODO_LOG=/data/todo.log -e TODO_ADMIN_EMAIL=admin@example.com -e TODO_ADMIN_KEY=local-admin-key localhost/todo:dev
10ea2ca585200e60e979a0e3ac7222780ab2ac8cbd9e86f7fbd3dc0d4bf64e4f

$ curl -sS -i http://127.0.0.1:18083/ready
HTTP/1.1 200 OK
Content-Security-Policy: default-src 'none'; script-src 'none'; style-src 'self'; img-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'
Content-Type: application/json
Referrer-Policy: no-referrer
...
{"status":"ok"}

$ podman logs todo-aws-shape | tail -1
{"time":"2026-10-31T09:22:18.035574552Z","level":"INFO","msg":"request","request_id":"xLuFeqbMEKCgTYrApPoeDAgQyIcCVTjq","trace_id":"34de61de5d69c159617dc8f52c2372cc","method":"GET","path":"/ready","status":200,"duration":1012231}
```
