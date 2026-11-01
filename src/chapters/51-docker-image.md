---
title: The app in a box
day: 61
time: "3 hours"
description: Build the server image from source, run it with a volume, and prove it answers.
sidebar:
  order: 51
---

The app has run from a terminal and from a server we set up by hand. Both
times, the program depended on the machine around it: the Go toolchain, the
libraries, the folders. Move it to another machine and something is always
missing.

A **container image** fixes that. It is a frozen filesystem with one
entrypoint: the server binary, the libraries it needs, and the folders it
writes. A **container** is that image running. The machine still provides the
kernel and the network; everything above them comes from the image.

Today we build the image from source, run it, and make `/ready` answer. A
first version of the runtime stage will fail — the base image is missing a
library the database engine loads — and that failure is the lesson.

## The recipe

A `Dockerfile` is the recipe for an image. Ours has two stages. The first uses
the Go image, copies the module files, downloads dependencies, then copies the
source and builds the server. The second stage starts from a small runtime
image and copies only the binary and the data directory.

<!-- verify: deploy/Dockerfile.dev at=docker-runtime -->
```dockerfile title="deploy/Dockerfile.dev"
FROM golang:1.26 AS build

WORKDIR /src

...
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /out/todo-server ./cmd/todo-server
```

The first stage is throwaway. The final image does not carry the Go toolchain
or the source; it carries the compiled binary. `CGO_ENABLED=0` keeps the build
from linking against the build machine's C library.

The order of the `COPY` lines matters. `go.mod` and `go.sum` change rarely;
the source changes constantly. Each instruction becomes a layer, and a layer
is reused until the files it copies change. Copying the module files first
means a source-only edit reuses the downloaded dependencies. The
`.dockerignore` file keeps `.git`, `dist`, and local databases out of the
build context, so the final `COPY . .` stays small.

A build is not a promise that the result runs. The build stage only proves
the Go compiler accepted the code; the runtime stage is where the image meets
the libraries it actually needs.

The second stage is the part that ships:

<!-- verify: deploy/Dockerfile.dev at=docker-runtime -->
```dockerfile title="deploy/Dockerfile.dev"
FROM gcr.io/distroless/cc-debian12:nonroot

...
COPY --from=build /out/todo-server /usr/local/bin/todo-server
COPY --chown=65532:65532 deploy/data/.keep /data/.keep
```

`distroless` means no shell and no package manager — just the runtime
libraries. `cc` is the variant that carries the C runtime and `libgcc`;
`nonroot` runs as uid 65532. The `.keep` file seeds `/data` with the right
owner, because distroless cannot run `mkdir`.

## Build it

:::note
The commands use `podman`, which runs without a daemon. Docker's commands are
the same; replace `podman` with `docker` in the blocks.
:::

From the app's root, build the image:

```bash
$ podman build -f deploy/Dockerfile.dev -t todo:dev .
...
Successfully tagged localhost/todo:dev
```

The name `todo:dev` is what we will use to run it. The build cache means a
source-only change reuses the dependency layer.

Run the image with a named volume:

```bash
$ podman run -d --name todo-pilot -p 8080:8080 -v todo-data:/data todo:dev
d48e86701432...
```

The volume is the app's data directory. A container's own filesystem
disappears when the container does; the volume does not. `todo-data` is a
named volume, not a folder you picked: Podman owns its location and gives it
back to any container that asks for it by name. `podman volume inspect
todo-data` prints that location when you need to look inside.

The difference matters the first time you replace the container. Stop it,
remove it, and start a new one with the same `-v todo-data:/data`; the new
container opens the same database. If the database lived in the container's
own filesystem, the second container would start empty. Ask the server
whether it is ready:

```bash
$ curl -sS -i http://127.0.0.1:8080/ready
HTTP/1.1 200 OK
Content-Type: application/json
...
{"status":"ok"}
```

`/ready` is the same readiness endpoint the server has answered since the API
days. A 200 means the process started and the store opened. The request id in
the response headers is the one in the log.

The image and the container are different things. The image is the recipe on
disk; the container is one running copy with its own network namespace and
process. `podman ps` shows the copies that exist, `podman logs` reads a copy's
output, and `podman stop` ends one without touching the image. That
separation is why the same image can run on a laptop, a test machine, and a
server without being rebuilt.

## The failure that teaches the base image

The first version of the runtime stage used
`gcr.io/distroless/base-debian12:nonroot`. The build succeeded. The container
did not. (To reproduce it, build the same file with `base` in place of `cc`
and name the result `todo:base`.)

```bash
$ podman run --name todo-base -p 8080:8080 todo:base
panic: unable to load turso library: failed to load library from path /tmp/turso-go/.../libturso_sync_sdk_kit.so: libgcc_s.so.1: cannot open shared object file: No such file or directory
...
```

The Go build used `CGO_ENABLED=0`, so the binary does not link a C library.
But the Turso engine is a native library loaded at runtime through purego. It
needs `libc` and `libgcc_s` on the machine that runs it. `base` has `libc` but
not `libgcc_s`; `cc` has both. That is the whole fix: change the base image,
not the Go code. The release image from the release day carries the same
base, so the fix lands in both Dockerfiles.

## If something went wrong

- **`libgcc_s.so.1: cannot open shared object file`** — the runtime image is
  too small. Use `gcr.io/distroless/cc-debian12:nonroot`, or install
  `libgcc-s1` in a Debian base.
- **`bind: address already in use`** — another process has port 8080. Stop it,
  or publish a different host port with `-p 18080:8080`.
- **`permission denied` on `/data`** — the volume was created by another user.
  Remove it with `podman volume rm todo-data`, or run the container with the
  uid that owns the directory.

<details>
<summary>Going deeper: why a frozen filesystem is not a virtual machine</summary>

A container shares the host kernel. That is why it starts in milliseconds and
why the image can be small: it does not carry an operating system, only the
files the process needs. The trade-off is that the kernel is not yours to
change. A container that needs a different kernel module is a virtual machine
in disguise.

The image is also immutable in the useful sense: the running container gets a
writable layer, but the image stays the same. The volume is the exception.
Anything that must survive a container is on a volume, or in a database
outside the container.

An image is a stack of layers, and a later layer can hide a file without
removing its bytes from the layer below. That is why the build stage is
separate: the Go toolchain, the module cache, and the source live in layers
the final image never inherits. It is also why a secret copied into an early
layer is still in the image even if a later layer deletes the file. Build
the small image by copying only what the process needs, not by deleting
things afterward.

</details>

The app is in a box now. Next we put the proxy in a box beside it and start
both with one command.
