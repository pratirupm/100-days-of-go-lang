---
title: The first cluster
day: 63
time: "3 hours"
description: Run the image as a Deployment and reach it through a Service, then read pods, events, and logs when the first rollout does not start.
sidebar:
  order: 53
---

Compose starts containers on the machine you are sitting at. That is enough
until the machine goes away, or until one process needs to be replaced while
the rest keep serving. A **cluster** is a group of machines that agrees on
where work should run and keeps it running.

**Kubernetes** is the cluster's control plane. We describe the desired state
— an image, a number of copies, a port — and Kubernetes compares it with what
is actually running. A **pod** is one running copy; a **Deployment** keeps a
chosen number of pods alive; a **Service** gives them one stable name.

Today we run the same server image as a Deployment and reach it through a
Service. The cluster is local — `kind` makes one inside containers — but the
objects are the ones a real cluster uses.

## Make a cluster

`kind` creates a Kubernetes cluster whose nodes are containers. It needs a
container runtime; on this machine it uses Podman.

```bash
$ kind create cluster --name todo
Creating cluster "todo" ...
...
Set kubectl context to "kind-todo"
```

The context is the address and credentials `kubectl` will use. `kubectl` is
the command-line client; it sends objects to the cluster's API server and
prints the result. The cluster is real, even though its nodes are containers
on this laptop.

## The desired state

A Deployment names the image and says how many copies should exist. It also
carries a label selector: the Deployment owns pods with the label `app: todo`.

<!-- verify: deploy/k8s/deployment.yaml at=k8s-deploy -->
```yaml title="deploy/k8s/deployment.yaml"
apiVersion: apps/v1
kind: Deployment
metadata:
  name: todo
  labels:
    app: todo
spec:
  replicas: 1
  selector:
    matchLabels:
      app: todo
  template:
    metadata:
      labels:
        app: todo
    spec:
      containers:
        - name: todo
          image: localhost/todo:dev
          imagePullPolicy: IfNotPresent
```

The pod template is everything inside `template:`. It looks like the Compose
service because it describes the same container: the image, the port, the
environment, and the volume. `imagePullPolicy: IfNotPresent` tells the node
to use the image already loaded into the cluster instead of trying a registry.

The environment and volume are below the part shown here:

<!-- verify: deploy/k8s/deployment.yaml at=k8s-deploy -->
```yaml title="deploy/k8s/deployment.yaml"
          env:
            - name: TODO_DB
              value: /data/todo.db
            - name: TODO_LOG
              value: /data/todo.log
            - name: TODO_LISTEN
              value: ":8080"
          volumeMounts:
            - name: data
              mountPath: /data
      volumes:
        - name: data
          emptyDir: {}
```

`emptyDir` is a directory that lives as long as the pod. It is enough for this
lesson because one pod owns the database. A later lesson gives the data a
life independent of the pod.

## The stable name

Pods come and go; their IP addresses change. A Service gives the Deployment
one name and one virtual address:

<!-- verify: deploy/k8s/service.yaml at=k8s-deploy -->
```yaml title="deploy/k8s/service.yaml"
apiVersion: v1
kind: Service
metadata:
  name: todo
  labels:
    app: todo
spec:
  selector:
    app: todo
  ports:
    - name: http
      port: 8080
      targetPort: http
```

The selector matches the pod label. `targetPort: http` names the container
port, so the Service does not repeat the number. Inside the cluster, another
pod can reach the server at `http://todo:8080`; outside, we forward a local
port for the demonstration.

## Put it in the cluster

The node cannot pull `localhost/todo:dev` from a registry. Save the image and
load the archive into the cluster:

```bash
$ podman save localhost/todo:dev -o /tmp/todo-dev.tar
...
$ kind load image-archive /tmp/todo-dev.tar --name todo
...
```

Now apply the objects. `kubectl apply` sends the files; the cluster creates
what is missing and updates what changed:

```bash
$ kubectl apply -f deploy/k8s/
deployment.apps/todo created
service/todo created
```

The Deployment creates a ReplicaSet, and the ReplicaSet creates the pod. Wait
for the rollout:

```bash
$ kubectl rollout status deployment/todo
Waiting for deployment "todo" rollout to finish: 0 of 1 updated replicas are available...
deployment "todo" successfully rolled out
```

Look at what exists:

```bash
$ kubectl get pods,svc
NAME                        READY   STATUS    RESTARTS   AGE
pod/todo-7f75ff4c67-h8pkm   1/1     Running   0          1s

NAME                 TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)    AGE
service/kubernetes   ClusterIP   10.96.0.1       <none>        443/TCP    3m17s
service/todo         ClusterIP   10.96.152.120   <none>        8080/TCP   1s
```

`READY 1/1` means the container is running and its readiness check passed.
There is no readiness probe yet, so Kubernetes treats a running container as
ready; the next lesson fixes that.

## Reach it

Forward a local port to the Service:

```bash
$ kubectl port-forward svc/todo 18090:8080
Forwarding from 127.0.0.1:18090 -> 8080
Forwarding from [::1]:18090 -> 8080
```

In another terminal, ask the app:

```bash
$ curl -sS -i http://127.0.0.1:18090/ready
HTTP/1.1 200 OK
Content-Type: application/json
...
{"status":"ok"}
```

The request went to the Service, the Service found the pod, and the app
answered. The port-forward is a development convenience; a real cluster
publishes the Service through an Ingress or a cloud load balancer.

## Labels and namespaces

The Deployment, the Service, and the pod all carry `app: todo`. That label is
the join key: the Service finds pods by it, and the Deployment owns pods by it.
A typo in one label is a Service with no endpoints, which looks like a
connection refused and is really a selector mismatch. `kubectl get endpoints
todo` is the fastest way to see it.

A namespace is a folder for objects and a boundary for names, quotas, and
access. This lesson uses `default` because there is one app. A real cluster
puts the app in its own namespace, gives the team a Role limited to that
namespace, and lets the network policy name the namespace instead of an IP.
The manifests do not change; the context does.

## The missing ingress

A Service is reachable inside the cluster. To reach it from a browser, the
cluster needs an **Ingress** or a load balancer. The Ingress names a host, a
path, and the Service; the controller configures the proxy that implements it.
Without one, `kubectl port-forward` is a development tool, not a deployment.

The Ingress is also where TLS terminates. The certificate, the redirect from
HTTP, and the host allowlist live there, not in the Deployment. The app keeps
its own security headers and CSP; the ingress adds the transport. The split is
the same one Caddy had on the single box.

## If something went wrong

- **`ImagePullBackOff`** — the node cannot find the image. The name in the
  Deployment must match the name loaded into the cluster. Check
  `podman exec todo-control-plane crictl images`; `localhost/todo:dev` is the
  name `kind load image-archive` produced.
- **`pod has unbound immediate PersistentVolumeClaims`** — the pod asks for a
  volume the cluster has not bound. This lesson uses `emptyDir`, so a PVC in
  the manifest means a later change arrived early.
- **`address already in use` from port-forward** — pick another local port,
  for example `18091:8080`.
- **`connection refused` through the Service** — the pod may be running but
  the app inside it is not. `kubectl logs deployment/todo` shows the server's
  own output.

<details>
<summary>Going deeper: controllers and the reconciliation loop</summary>

A Deployment does not create pods directly. It creates a ReplicaSet, and the
ReplicaSet creates pods. Each controller watches the objects it owns and
compares the desired count with the actual count. If a pod dies, the
ReplicaSet creates another; if the image changes, the Deployment creates a
new ReplicaSet and moves pods over according to its rollout strategy.

That loop is the important idea. Nothing sends a one-time "start this pod"
command; the cluster keeps reading the desired state and closing the gap.
The next lesson uses that same loop for configuration and health.

</details>

The app is scheduled now, but the cluster does not yet know when it is truly
ready. Next we teach the probes what the app already knows.
