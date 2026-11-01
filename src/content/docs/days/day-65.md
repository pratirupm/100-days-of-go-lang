---
title: "Day 65 — Rolling forward"
description: "Ship a new image without dropping a request, then roll back to the previous revision when the new one is wrong. — Day 65 of 100 Days of Go Lang."
sidebar:
  order: 65
chapter: 55
style: production
---

**About 3 hours** · Part XI, day 5 of 5.

**You'll be able to:**

- ship a new image without dropping a request;
- roll back to the previous revision when the new one is wrong.

---

A Deployment is useful because changing it is safe. Replace the image and
Kubernetes creates a new pod, waits for it to pass its readiness probe, and
only then removes the old one. If the new pod never becomes ready, the old
one keeps serving.

That sentence depends on two settings. The rollout strategy says how many
extra pods may exist and how many may be missing during the change. The
readiness probe says when a new pod is allowed to take traffic. Without the
probe, a broken image can be declared ready while it is still crashing.

Today we build a second image with a different version, roll it out, watch
the logs change, and roll back.

## The version stamp

The server prints its version when it starts. The release days stamped that
version through linker flags; the dev image can do the same:

<!-- verify: deploy/Dockerfile.dev at=k8s-rollout -->
```dockerfile title="deploy/Dockerfile.dev"
ARG VERSION=dev

...
RUN CGO_ENABLED=0 go build -trimpath \
    -ldflags "-X todo/internal/version.Version=${VERSION}" \
    -o /out/todo-server ./cmd/todo-server
```

`ARG` is a build-time input, not a runtime environment variable. The value is
baked into the binary, so two images built from the same source can still
identify themselves differently. The default keeps `podman build .` working
without flags.

Build the second image:

```bash
$ podman build --build-arg VERSION=v2 -f deploy/Dockerfile.dev -t localhost/todo:v2 .
...
Successfully tagged localhost/todo:v2
```

The image name and the version are separate. `localhost/todo:v2` is the
registry name; `v2` inside the binary is what the log prints. Keeping them in
step is a convention, not a guarantee.

## The rollout policy

The Deployment now names the new image and a rolling strategy:

<!-- verify: deploy/k8s/deployment.yaml at=k8s-rollout -->
```yaml title="deploy/k8s/deployment.yaml"
spec:
  replicas: 1
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  minReadySeconds: 2
  progressDeadlineSeconds: 60
  revisionHistoryLimit: 3
```

`maxSurge: 1` allows one extra pod during the change.
`maxUnavailable: 0` forbids taking the old pod away until a new one is ready.
With one replica, the cluster temporarily runs two pods. `minReadySeconds: 2`
makes a pod prove it stays ready for two seconds before it counts.
`progressDeadlineSeconds: 60` marks the rollout failed if it makes no progress
for a minute. `revisionHistoryLimit: 3` keeps the last three ReplicaSets for
rollback.

The image line is the change that triggers the rollout:

<!-- verify: deploy/k8s/deployment.yaml at=k8s-rollout -->
```yaml title="deploy/k8s/deployment.yaml"
          image: localhost/todo:v2
          imagePullPolicy: IfNotPresent
```

`IfNotPresent` means the node uses the image loaded into it. A real cluster
would pull from a registry and use an immutable digest instead of a mutable
name.

## Roll it out

Save and load the image, then apply:

```bash
$ podman save localhost/todo:v2 -o /tmp/todo-v2.tar
...
$ kind load image-archive /tmp/todo-v2.tar --name todo
...
$ kubectl apply -f deploy/k8s/
configmap/todo-config unchanged
secret/todo-secrets configured
deployment.apps/todo configured
service/todo unchanged
```

Watch the rollout:

```bash
$ kubectl rollout status deployment/todo
Waiting for deployment "todo" rollout to finish: 1 old replicas are pending termination...
deployment "todo" successfully rolled out
```

The old pod is terminating, not gone instantly. It keeps serving until the
new pod is ready, then receives its stop signal. The app's graceful shutdown
gives in-flight requests time to finish.

:::caution
This lab uses `emptyDir`, so the new pod starts with an empty `/data`. The
rollout moves traffic, not data. A production deployment uses a
`PersistentVolumeClaim` or a database outside the pod.
:::

Check the new pod and its version:

```bash
$ kubectl get pods
NAME                    READY   STATUS        RESTARTS   AGE
todo-5cb5c786d5-kcdnh   1/1     Running       0          12s

$ kubectl logs deployment/todo | head -2
{"time":"2026-10-31T09:20:03.477474616Z","level":"INFO","msg":"admin credential ensured","email":"admin@example.com","created":true,"rotated":false,"granted":true}
{"time":"2026-10-31T09:20:03.477930374Z","level":"INFO","msg":"server listening","addr":":8080","version":"v2"}
```

`version":"v2"` is the proof the new binary is serving. A rollout that only
changed the pod name would be a false positive; the version is the fact.

## Roll it back

`kubectl rollout undo` moves the Deployment to the previous ReplicaSet:

```bash
$ kubectl rollout undo deployment/todo
Warning: resource deployments/todo was previously managed with 'kubectl apply'. Rolling back will not update the kubectl.kubernetes.io/last-applied-configuration annotation, which may cause unexpected behavior on future 'kubectl apply' operations. Consider using 'kubectl apply' with your previous configuration file instead.
deployment.apps/todo rolled back
```

The warning is about GitOps hygiene, not a failure. The live Deployment moved
back; the file on disk still describes `v2`. The next `kubectl apply` would
move forward again. In a real workflow the file is the source of truth, and a
rollback is a new change to the file, not an edit to the live object.

Wait for the rollback and read the version:

```bash
$ kubectl rollout status deployment/todo
Waiting for deployment "todo" rollout to finish: 0 out of 1 new replicas have been updated...
deployment "todo" successfully rolled out

$ kubectl logs deployment/todo | head -2
{"time":"2026-10-31T09:20:20.973018645Z","level":"INFO","msg":"admin credential ensured","email":"admin@example.com","created":true,"rotated":false,"granted":true}
{"time":"2026-10-31T09:20:20.973517292Z","level":"INFO","msg":"server listening","addr":":8080","version":"dev"}
```

The version is back to `dev`. The rollback used the previous ReplicaSet; no
new image was built.

## Zero downtime is a chain

The Deployment's strategy is one link. The readiness probe is another: a pod
that reports ready before it can serve will receive traffic too early. The
app's graceful shutdown is a third: a pod that is removed while a request is
in flight drops that request. The Service's endpoint removal and the
preStop hook are a fourth.

The chain is only as strong as its slowest link. A `maxUnavailable: 0` with a
readiness probe that always passes is a false guarantee. The book's app has a
real `/ready` and a drain budget; the manifest's `minReadySeconds` gives the
probe a second look. That is why the lesson can claim no dropped requests for
the cases it exercises, and why a different app needs its own proof.

A rollback is the same chain in reverse. It restores the previous template,
but it does not undo a database migration. The next part's migrations are
written to be backward-compatible for exactly this reason.

## If something went wrong

- **The rollout never finishes** — a new pod is not becoming ready. Run
  `kubectl get pods`, `kubectl describe pod`, and `kubectl logs` before
  rolling back. A failing readiness probe is the usual cause.
- **`ImagePullBackOff` for `v2`** — the node does not have the image. Load
  the archive or publish it to a registry; the name in the Deployment must
  match the loaded name.
- **`progressDeadlineExceeded`** — the Deployment made no progress for a
  minute. The old pods are still serving; fix the new image or roll back.
- **`maxUnavailable: 0` with a single replica and no surge** — the rollout
  cannot create the new pod without removing the old one. Keep
  `maxSurge: 1`, or add replicas.

<details>
<summary>Going deeper: ReplicaSets are the revision history</summary>

Every change to the pod template creates a new ReplicaSet. The Deployment
owns the ReplicaSets and moves the desired replica count between them. A
rollout is not a mutation of pods; it is a sequence of ReplicaSet scale
changes. `kubectl rollout history` lists the revisions, and `kubectl rollout
undo --to-revision=N` picks one.

The old ReplicaSet is kept, scaled to zero, until the revision history limit
removes it. That is why a rollback is fast: the image and template are still
described. It is also why a rollback cannot recover a deleted Secret or a
database migration; those are outside the Deployment's history.

</details>

The app can now move between versions without dropping traffic. The next
part takes the same shape to a cloud, where the machines are not ours.

<div class="day-tracker" data-day="65"></div>
