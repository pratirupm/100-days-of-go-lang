---
title: Config, probes, and limits
day: 64
time: "3 hours"
description: Feed the app configuration and secrets without rebuilding the image, and make readiness and liveness probes tell the cluster the truth.
sidebar:
  order: 54
---

The pod from the last lesson runs, but it carries its settings in the
manifest and its health in the dark. Changing a path means editing the
Deployment; a process that is alive but cannot reach its database still
receives traffic.

Kubernetes has three separate tools for those gaps. A **ConfigMap** holds
non-secret settings. A **Secret** holds values that should not sit in the pod
template. A **probe** is a check the kubelet runs against the container —
**readiness** decides whether the pod receives traffic, and **liveness**
decides whether it should be restarted.

Today we move the settings out of the Deployment, add both probes, and give
the container a CPU and memory budget.

## The settings

The ConfigMap is a named set of key-value pairs. Ours holds the paths and the
listen address:

<!-- verify: deploy/k8s/config.yaml at=k8s-config -->
```yaml title="deploy/k8s/config.yaml"
apiVersion: v1
kind: ConfigMap
metadata:
  name: todo-config
  labels:
    app: todo
data:
  TODO_DB: /data/todo.db
  TODO_LOG: /data/todo.log
  TODO_LISTEN: ":8080"
  TODO_ADMIN_EMAIL: admin@example.com
```

The Secret has the same shape, but its values are stored separately from the
rest of the configuration and are redacted from most command output:

<!-- verify: deploy/k8s/config.yaml at=k8s-config -->
```yaml title="deploy/k8s/config.yaml"
apiVersion: v1
kind: Secret
metadata:
  name: todo-secrets
  labels:
    app: todo
type: Opaque
stringData:
  TODO_ADMIN_KEY: local-admin-key
```

`stringData` lets us write the value as plain text in the file; Kubernetes
encodes it when it stores the object. That is convenience, not encryption.
Anyone who can read Secrets in the namespace can read this value. A real
cluster uses a secret manager or an encrypted Secret, and the local value is
only for the exercise.

The Deployment now reads both objects as environment variables:

<!-- verify: deploy/k8s/deployment.yaml at=k8s-config -->
```yaml title="deploy/k8s/deployment.yaml"
          envFrom:
            - configMapRef:
                name: todo-config
            - secretRef:
                name: todo-secrets
```

`envFrom` imports every key as an environment variable. The app already reads
`TODO_DB`, `TODO_LOG`, `TODO_LISTEN`, `TODO_ADMIN_KEY`, and
`TODO_ADMIN_EMAIL`, so no code changes. If a key is missing from the
ConfigMap, the pod starts without it and the app falls back to its default —
which is exactly the kind of failure the next section catches.

## The probes

A running process is not necessarily a working server. The app already has
two endpoints for the difference: `/healthz` says the process is alive and
touches no dependency; `/ready` pings the store and answers 503 when it cannot.

<!-- verify: deploy/k8s/deployment.yaml at=k8s-config -->
```yaml title="deploy/k8s/deployment.yaml"
          readinessProbe:
            httpGet:
              path: /ready
              port: http
            initialDelaySeconds: 2
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /healthz
              port: http
            initialDelaySeconds: 5
            periodSeconds: 10
```

The readiness probe runs every five seconds. Until it succeeds, the Service
does not send the pod traffic. The liveness probe runs every ten seconds;
after three failures, the kubelet restarts the container. The delays give the
server time to open its store before the first check.

The container also gets a budget:

<!-- verify: deploy/k8s/deployment.yaml at=k8s-config -->
```yaml title="deploy/k8s/deployment.yaml"
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 500m
              memory: 256Mi
```

Requests are what the scheduler reserves; limits are the ceiling. A container
that asks for more memory than its limit is killed and restarted, which is
why the limit must sit above the app's real working set. The 256 MiB ceiling
matches the server's own heap budget from the performance days.

## Apply it

```bash
$ kubectl apply -f deploy/k8s/
configmap/todo-config created
secret/todo-secrets created
deployment.apps/todo configured
service/todo unchanged
```

The Deployment changes, so Kubernetes creates a new ReplicaSet and a new pod.
The old pod keeps serving until the new one is ready:

```bash
$ kubectl rollout status deployment/todo
Waiting for deployment "todo" rollout to finish: 1 old replicas are pending termination...
deployment "todo" successfully rolled out
```

Look at the result:

```bash
$ kubectl get pods
NAME                    READY   STATUS    RESTARTS   AGE
todo-54f5b8f594-fbc75   1/1     Running   0          16s
```

`READY 1/1` is the readiness probe passing. Ask the pod what the kubelet is
checking:

```bash
$ kubectl describe pod todo-54f5b8f594-fbc75 | grep -E 'Liveness:|Readiness:'
    Liveness:   http-get http://:http/healthz delay=5s timeout=1s period=10s successThreshold=1 failureThreshold=3
    Readiness:  http-get http://:http/ready delay=2s timeout=1s period=5s successThreshold=1 failureThreshold=3
```

Read the imported settings:

```bash
$ kubectl get configmap todo-config -o jsonpath='{.data}'
{"TODO_ADMIN_EMAIL":"admin@example.com","TODO_DB":"/data/todo.db","TODO_LISTEN":":8080","TODO_LOG":"/data/todo.log"}
```

The Secret is listed by name, type, and key count; its value is not printed:

```bash
$ kubectl get secret todo-secrets
NAME           TYPE     DATA   AGE
todo-secrets   Opaque   1      3m28s
```

## Secrets are not encryption

A Kubernetes Secret is base64-encoded data, not encrypted data. Anyone with
`get secrets` in the namespace can read it, and anyone with access to etcd can
read it unless encryption at rest is configured. The encoding is there so
binary values survive YAML, not to protect them.

The controls that matter are around the Secret: RBAC that limits who can read
it, encryption at rest on the API server, a secret manager that owns the
rotation, and a pod spec that mounts the value instead of baking it into an
image. The local `stringData` is a convenience for the exercise; a production
manifest references an external secret or a sealed secret, and the value never
lands in the project.

The same rule applies to the ConfigMap. It is not secret, but it is still
configuration: a change is a rollout, and a bad value is a failed readiness
probe. Treat both objects as code, review them, and keep the environment's
values out of the shared file.

## If something went wrong

- **`CrashLoopBackOff` with “the admin key is set but TODO_ADMIN_EMAIL is
  not”** — the Secret has a key but the ConfigMap is missing the account it
  belongs to. Add `TODO_ADMIN_EMAIL` to the ConfigMap; the real message is
  the app's own bootstrap check, not a Kubernetes error.
- **`CreateContainerConfigError`** — the pod names a ConfigMap or Secret that
  does not exist in its namespace. `kubectl get configmap,secret` shows what
  is actually there.
- **The pod stays `0/1 Running`** — the readiness probe is failing. Check
  `kubectl logs deployment/todo` and `kubectl describe pod`; a 503 from
  `/ready` means the store, not the HTTP server, is the problem.
- **The pod restarts every few seconds** — the liveness probe is failing or
  the memory limit is too low. Look at `kubectl describe pod` for
  `OOMKilled` or probe failures before changing the limit.

<details>
<summary>Going deeper: requests, limits, and the quality of service</summary>

Kubernetes uses requests and limits to decide where a pod can run and what
happens when the node is under pressure. A pod with requests equal to its
limits is **Guaranteed**; a pod with requests below limits is **Burstable**;
a pod with no requests or limits is **BestEffort**. Under memory pressure,
the eviction order starts with BestEffort, then Burstable pods above their
requests, and Guaranteed last.

The numbers are not decoration. A memory limit below the app's working set
turns a healthy process into a restart loop; a CPU limit far below the
request throttles it even when the node is idle. The performance days gave
us a measured heap ceiling; this is where that measurement becomes an
operational setting.

</details>

The pod now knows its settings and its health. Next we change the image under
it and watch the cluster move traffic without dropping a request.
