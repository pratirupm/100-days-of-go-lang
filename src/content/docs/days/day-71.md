---
title: "Day 71 — Deploying a change"
description: "Ship the artifact the checks passed, smoke-test the new revision, and keep the rollback a deliberate decision. — Day 71 of 100 Days of Go Lang."
sidebar:
  order: 71
chapter: 60
style: production
---

**About 3 hours** · Part XII, day 5 of 5.

**You'll be able to:**

- deploy the artifact the checks passed;
- smoke-test the new revision and roll back when it fails.

---

The checks run on every change. The deploy is still a decision. That gap is
deliberate: a check can run on a fork with no secrets, while a deploy needs a
target, credentials, and a human who is willing to be paged.

**Continuous delivery** closes the gap by making the deploy repeatable. The
same artifact that passed the checks is the artifact that ships. A smoke test
decides whether the new revision stays; a rollback is one more run of the
same steps with the previous artifact.

Today we look at the production workflow, then run its shape against the
local cluster.

## The production job

The deploy workflow is dispatched by a human and gated by a GitHub
environment. The environment is where the secrets live and where reviewers
are configured; a workflow cannot name a secret the environment does not
grant it.

<!-- verify: .github/workflows/deploy.yml at=cd-deploy -->
```yaml title=".github/workflows/deploy.yml"
on:
  workflow_dispatch:
    inputs:
      ref:
        description: ref to deploy (a branch or tag)
        default: main
        required: false
```

The `ref` input is what makes a rollback possible: dispatch the workflow with
the previous revision, and the same job ships the older artifact. The job checks
out that ref, runs `make check`, builds the binary, and copies it to the host:

<!-- verify: .github/workflows/deploy.yml at=cd-deploy -->
```yaml title=".github/workflows/deploy.yml"
      - name: gate
        run: make check
      - name: build
        run: CGO_ENABLED=0 go build -trimpath -o dist/todo-server ./cmd/todo-server
```

The build happens after the check, from the same tree. The artifact is not
rebuilt on the host; it is copied and installed. That is the "build once"
rule: the bytes that passed are the bytes that run.

The last step checks readiness through the app's own endpoint:

<!-- verify: .github/workflows/deploy.yml at=cd-deploy -->
```yaml title=".github/workflows/deploy.yml"
      - name: check
        env:
          DEPLOY_HOST: ${{ secrets.DEPLOY_HOST }}
          DEPLOY_USER: ${{ secrets.DEPLOY_USER }}
        run: |
          ssh -i ~/.ssh/deploy_key "$DEPLOY_USER@$DEPLOY_HOST" \
            'curl -fsS http://127.0.0.1:8080/ready'
```

The install step copies the current binary to `todo-server.prev` before it
overwrites it. A failed check still leaves the previous binary on the host, and
the runbook's rollback step installs it. The pipeline does not silently leave a
broken revision in place; a rollback is a new dispatch with the previous
revision, not a hidden undo.

## The local shape

The same steps run against the local cluster in `deploy/aws/rollout.sh`:

<!-- verify: deploy/aws/rollout.sh at=cd-deploy -->
```sh title="deploy/aws/rollout.sh"
#!/bin/sh
# deploy/aws/rollout.sh — the deploy steps, run against the local cluster.
#
# The production workflow ships a binary over ssh. This script runs the same
# shape against kind: build the artifact, load it, apply the desired state,
# wait for the rollout, and smoke the result.
set -eu

: "${KIND_CLUSTER:=todo}"
: "${IMAGE:=localhost/todo:v2}"
: "${VERSION:=v2}"

podman build --build-arg VERSION="$VERSION" -f deploy/Dockerfile.dev -t "$IMAGE" .
podman save "$IMAGE" -o /tmp/todo-rollout.tar
kind load image-archive /tmp/todo-rollout.tar --name "$KIND_CLUSTER"

kubectl apply -f deploy/k8s/
kubectl rollout status deployment/todo --timeout=120s
```

The script then forwards a port and calls the smoke check:

<!-- verify: deploy/aws/smoke.sh at=cd-deploy -->
```sh title="deploy/aws/smoke.sh"
#!/bin/sh
# deploy/aws/smoke.sh — wait for a deployed server to answer /ready.
set -eu

: "${TODO_URL:?set TODO_URL}"

for _ in $(seq 1 30); do
  if curl -fsS "${TODO_URL}/ready" >/dev/null; then
    echo "ready: ${TODO_URL}"
    exit 0
  fi
  sleep 1
done

echo "not ready: ${TODO_URL}" >&2
exit 1
```

The loop is the same thirty-second budget the CI smoke uses. A deploy that
cannot answer readiness within it is not ready, even if the process is
running.

Run the local rollout:

```bash
$ ./deploy/aws/rollout.sh
...
deployment "todo" successfully rolled out
ready: http://127.0.0.1:18086
```

The first line proves the desired state was applied; the second proves the
new pod serves. The port-forward is closed by the script's trap when it
exits.

The production workflow is checked the same way:

```bash
$ actionlint .github/workflows/deploy.yml
...
```

No output means the workflow's syntax and expressions are sound. The job
still needs a real environment and secrets before it can ship.

## Why the button is still a decision

A push-triggered deploy is possible; it is the same job with `on: push`
instead of `workflow_dispatch`. The manual button buys two things: a human
can choose the moment, and a rollback is the same button with an older ref.
For a single-instance app with a database, that is the right first step.

The next step would be an environment protection rule and a required
reviewer, then a canary or a blue-green swap. Those are changes to the
deployment target, not to the app. The app's contract stays the same: a
binary, a readiness endpoint, and a graceful shutdown.

## Rollback is a deploy

The rollback path is not a special mode. It is the same job with an older ref:
check out the ref, run the checks, build the binary, copy it, restart, and
smoke it. The previous artifact is the one that passed before, so the rollback
is a known-good deployment rather than an undo button.

That is why the ref is an input. A branch name that moves is a bad rollback target; a
commit digest is a stable one. The pipeline should accept the digest, not a
branch name, for the same reason the container should be named by digest. A
branch is a pointer that can move between the decision and the deploy.

The database is the part the rollback cannot undo. A migration that added a
column is backward-compatible; a migration that dropped one is not. The
deploy order is migrate forward, deploy code that reads both shapes, then
remove the old shape later. The rollback of the code is safe only while the
schema still supports it.

## If something went wrong

- **The deploy job cannot find a secret** — the environment does not grant
  it. Check the environment name and its secrets; a project secret is not
  visible to a protected environment unless it is added there.
- **`make check` fails on the ref** — the ref is older than the check's
  requirements. Deploy a ref that passed, or fix the check and deploy the
  fix; do not skip the check.
- **The smoke check fails after install** — the new binary is installed but
  not ready. Roll back with the previous ref and read the server log before
  retrying.
- **`ssh: handshake failed`** — the host key changed or the key is wrong.
  Do not disable host-key checking; update `DEPLOY_KNOWN_HOSTS` from the
  host's console.

<details>
<summary>Going deeper: delivery versus deployment</summary>

Continuous delivery means every change is deployable; continuous deployment
means every change deploys without a human. The difference is a policy
decision, not a technical one. The same pipeline can support either; the
trigger changes.

The artifact is the unit of trust. A name can move, a branch can move, a
container name can be overwritten; a digest cannot. The release days built
archives with checksums and a container image from the same binaries. The
deploy should name the digest, not the name. That is what makes "the bytes
that passed are the bytes that run" true across a registry and a CDN.

</details>

The app can ship itself now, with a check and a way back. The next part gives
it a production database and the numbers to prove the change.

<div class="day-tracker" data-day="71"></div>
