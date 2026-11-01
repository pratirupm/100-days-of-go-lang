---
title: Two containers, one command
day: 62
time: "3 hours"
description: Describe the app and its proxy in one Compose file, then start and inspect the stack without remembering every flag.
sidebar:
  order: 52
---

The app is in an image now. The proxy is not. Starting them by hand means two
commands, a network name, a volume name, and a port mapping — and remembering
all of it again after a reboot.

**Compose** turns that memory into a file. The file describes the services,
the network between them, and the volumes they share. One command starts the
stack; another stops it. The description is also documentation: a reader can
see how the pieces fit without reading a shell history.

Today we write that file and run the app behind its proxy with one command.

## The file

A Compose file is a YAML document with a `services` section. Each service is
one container. Ours has two: `app` and `proxy`.

<!-- verify: compose.yaml at=compose -->
```yaml title="compose.yaml"
services:
  app:
    build:
      context: .
      dockerfile: deploy/Dockerfile.dev
    image: todo:dev
    environment:
      TODO_DB: /data/todo.db
      TODO_LOG: /data/todo.log
      TODO_LISTEN: ":8080"
    volumes:
      - todo-data:/data
    expose:
      - "8080"
```

The `build` block tells Compose where the image comes from. `image` gives the
result a name, so the proxy and later commands can refer to it. `environment`
is the same configuration the server read from the shell; the values are
written here so the stack starts the same way every time. `expose` publishes
port 8080 to the Compose network, not to the host — only the proxy needs to
reach it.

The `proxy` service is the front door:

<!-- verify: compose.yaml at=compose -->
```yaml title="compose.yaml"
  proxy:
    image: docker.io/library/caddy:2
    depends_on:
      - app
    ports:
      - "8081:80"
    volumes:
      - ./deploy/Caddyfile.compose:/etc/caddy/Caddyfile:ro,Z
```

`ports` maps host port 8081 to Caddy's port 80. `depends_on` starts the app
first, though it does not wait for readiness; Caddy will answer 502 until the
server is listening. The `:Z` on the volume is the SELinux label — without it,
the container may see the file but not be allowed to read it on a Fedora host.

The bottom of the file declares the shared volume:

<!-- verify: compose.yaml at=compose -->
```yaml title="compose.yaml"
volumes:
  todo-data:
```

## The proxy's one job

Caddy reads a `Caddyfile`. The production file terminates TLS for a public
name; the local one keeps the same shape on plain HTTP:

<!-- verify: deploy/Caddyfile.compose at=compose -->
```caddyfile title="deploy/Caddyfile.compose"
:80 {
	reverse_proxy app:8080
}
```

`app` is a hostname inside the Compose network. Compose creates a DNS entry
for every service, so the proxy reaches the app by name instead of an IP. The
app still owns its headers and compression; Caddy only passes the request
through.

## Bring it up

From the app's root, build and start both services:

```bash
$ podman compose up -d --build
...
 Container go-todo-app-app-1 Started
 Container go-todo-app-proxy-1 Started
```

The first run builds the image and creates the network and volume. Later runs
reuse them. Ask Compose what is running:

```bash
$ podman compose ps --format 'table {{.Name}}\t{{.Service}}\t{{.Status}}'
NAME                  SERVICE   STATUS
go-todo-app-app-1     app       Up 22 seconds
go-todo-app-proxy-1   proxy     Up 6 seconds
```

Both services are up. The app is not published on the host; only the proxy
is. Ask the proxy for readiness:

```bash
$ curl -sS -i http://127.0.0.1:8081/ready
HTTP/1.1 200 OK
Content-Type: application/json
Via: 1.1 Caddy
...
{"status":"ok"}
```

`Via: 1.1 Caddy` is the proof the request went through the proxy rather than
straight to the app. The app's own security headers are still in the response;
Caddy did not add or remove them.

When the stack is no longer needed, stop it:

```bash
$ podman compose down
```

`down` removes the containers and the network, not the named volume. The
database survives; `down -v` is the command that also deletes the volume, and
it is the one to use when you want a clean slate.

## What Compose does not do

Compose does not health-check the app before starting the proxy. `depends_on`
orders the start, not the readiness; Caddy will answer 502 until the server is
listening. A `healthcheck` on the app and a `condition: service_healthy` on the
proxy would close that gap, at the cost of a check that must know how to probe
a distroless image with no shell. The app's `/ready` endpoint is the right
probe; the missing piece is a client inside the image or a sidecar that can
call it.

Compose also does not restart a failed service forever, roll out a new image
gradually, or move a container to another machine. `restart: unless-stopped`
covers the first; the cluster covers the rest. The file is a development and
single-host shape, and it is honest about that.

## The network is implicit

Compose creates one bridge network for the project and attaches every service
to it. The service name is the DNS name; `app` resolves to the app container's
address. A service that is not on the network cannot reach the app by name, and
a host process cannot reach it by name at all.

The isolation is useful: the app is not published on the host, so only the
proxy on the Compose network can reach it. The proxy is the one service with a
host port. That is the same shape as the production deployment, where the app
has a private address and the proxy has the public one.

## Bind mounts and named volumes

The Caddyfile is a **bind mount**: a host path appears inside the container.
The database is a **named volume**: Compose owns the path and gives it back by
name. The bind mount is for files you edit; the named volume is for data you
must keep.

A bind mount can carry the host's permissions and SELinux label into the
container, which is why the file has `:Z`. A named volume is created with the
container's ownership, which is why the app's data directory works without a
chown. Mixing the two is how a database ends up owned by the wrong user.

## If something went wrong

- **`port 8081 is already allocated`** — another stack or a local process has
  the port. Change the host side of the mapping, for example `8082:80`.
- **The proxy answers 502** — it is running, but the app is not ready yet.
  Check `podman compose logs app`; the server may still be opening the store,
  or it may have failed on a missing library.
- **`permission denied` reading the Caddyfile** — on an SELinux host, add the
  `:Z` flag to the bind mount, as the file above does.
- **`looking up compose provider failed`** — Podman needs a Compose provider.
  Install Docker Compose's plugin, or use `podman-compose`; the file is the
  same.

<details>
<summary>Going deeper: what Compose is and is not</summary>

Compose is a local model of a deployment, not a production orchestrator. It
starts containers on one machine, restarts them when they exit, and gives
them a shared network. It does not schedule across machines, roll out a new
version gradually, or heal a failed node. Those are the jobs of the cluster
we meet next.

The value is the description. The same service names, environment variables,
and volume names can be translated into a Kubernetes manifest or a cloud task
definition. The local stack is where the shape is cheap to change.

</details>

The stack starts with one command now. Next we give the same shape to a
cluster that can reschedule it when a machine disappears.
