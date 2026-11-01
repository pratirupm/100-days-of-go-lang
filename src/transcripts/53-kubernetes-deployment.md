# Chapter 53 — the first cluster

```text
$ kind create cluster --name todo
Creating cluster "todo" ...
...
Set kubectl context to "kind-todo"

$ podman save localhost/todo:dev -o /tmp/todo-dev.tar
...
$ kind load image-archive /tmp/todo-dev.tar --name todo
...
$ kubectl apply -f deploy/k8s/
deployment.apps/todo created
service/todo created

$ kubectl rollout status deployment/todo
Waiting for deployment "todo" rollout to finish: 0 of 1 updated replicas are available...
deployment "todo" successfully rolled out

$ kubectl get pods,svc
NAME                        READY   STATUS    RESTARTS   AGE
pod/todo-7f75ff4c67-h8pkm   1/1     Running   0          1s

NAME                 TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)    AGE
service/kubernetes   ClusterIP   10.96.0.1       <none>        443/TCP    3m17s
service/todo         ClusterIP   10.96.152.120   <none>        8080/TCP   1s

$ kubectl port-forward svc/todo 18090:8080
Forwarding from 127.0.0.1:18090 -> 8080
Forwarding from [::1]:18090 -> 8080

$ curl -sS -i http://127.0.0.1:18090/ready
HTTP/1.1 200 OK
Content-Type: application/json
...
{"status":"ok"}
```
