# Chapter 55 — rolling forward

```text
$ podman build --build-arg VERSION=v2 -f deploy/Dockerfile.dev -t localhost/todo:v2 .
...
Successfully tagged localhost/todo:v2

$ podman save localhost/todo:v2 -o /tmp/todo-v2.tar
...
$ kind load image-archive /tmp/todo-v2.tar --name todo
...

$ kubectl apply -f deploy/k8s/
configmap/todo-config unchanged
secret/todo-secrets configured
deployment.apps/todo configured
service/todo unchanged

$ kubectl rollout status deployment/todo
Waiting for deployment "todo" rollout to finish: 1 old replicas are pending termination...
deployment "todo" successfully rolled out

$ kubectl get pods
NAME                    READY   STATUS        RESTARTS   AGE
todo-5cb5c786d5-kcdnh   1/1     Running       0          12s

$ kubectl logs deployment/todo | head -2
{"time":"2026-10-31T09:20:03.477474616Z","level":"INFO","msg":"admin credential ensured","email":"admin@example.com","created":true,"rotated":false,"granted":true}
{"time":"2026-10-31T09:20:03.477930374Z","level":"INFO","msg":"server listening","addr":":8080","version":"v2"}

$ kubectl rollout undo deployment/todo
Warning: resource deployments/todo was previously managed with 'kubectl apply'. Rolling back will not update the kubectl.kubernetes.io/last-applied-configuration annotation, which may cause unexpected behavior on future 'kubectl apply' operations. Consider using 'kubectl apply' with your previous configuration file instead.
deployment.apps/todo rolled back

$ kubectl rollout status deployment/todo
Waiting for deployment "todo" rollout to finish: 0 out of 1 new replicas have been updated...
deployment "todo" successfully rolled out

$ kubectl logs deployment/todo | head -2
{"time":"2026-10-31T09:20:20.973018645Z","level":"INFO","msg":"admin credential ensured","email":"admin@example.com","created":true,"rotated":false,"granted":true}
{"time":"2026-10-31T09:20:20.973517292Z","level":"INFO","msg":"server listening","addr":":8080","version":"dev"}
```
