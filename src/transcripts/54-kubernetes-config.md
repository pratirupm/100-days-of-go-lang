# Chapter 54 — config, probes, and limits

```text
$ kubectl apply -f deploy/k8s/
configmap/todo-config created
secret/todo-secrets created
deployment.apps/todo configured
service/todo unchanged

$ kubectl rollout status deployment/todo
Waiting for deployment "todo" rollout to finish: 1 old replicas are pending termination...
deployment "todo" successfully rolled out

$ kubectl get pods
NAME                    READY   STATUS    RESTARTS   AGE
todo-54f5b8f594-fbc75   1/1     Running   0          16s

$ kubectl describe pod todo-54f5b8f594-fbc75 | grep -E 'Liveness:|Readiness:'
    Liveness:   http-get http://:http/healthz delay=5s timeout=1s period=10s successThreshold=1 failureThreshold=3
    Readiness:  http-get http://:http/ready delay=2s timeout=1s period=5s successThreshold=1 failureThreshold=3

$ kubectl get configmap todo-config -o jsonpath='{.data}'
{"TODO_ADMIN_EMAIL":"admin@example.com","TODO_DB":"/data/todo.db","TODO_LISTEN":":8080","TODO_LOG":"/data/todo.log"}

$ kubectl get secret todo-secrets
NAME           TYPE     DATA   AGE
todo-secrets   Opaque   1      3m28s
```
