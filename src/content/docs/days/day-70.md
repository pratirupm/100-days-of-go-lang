---
title: "Day 70 — Checks on every change"
description: "Run the same suite, image build, and readiness smoke on every change, and read a failed job before touching the code. — Day 70 of 100 Days of Go Lang."
sidebar:
  order: 70
chapter: 59
style: production
---

**About 3 hours** · Part XII, day 4 of 5.

**You'll be able to:**

- run the same suite, build, and container check on every push;
- read a failed job and fix the first real failure.

---

A check that only runs on a laptop is a habit. A check that runs on every
change is a condition. The difference matters when the change comes from
someone else, or from you at the end of a long day.

**Continuous integration** is the practice of running the checks on every
change, in a clean environment, before the change is accepted. The app has
carried a workflow file since the first sixty days; today we add the one
check that was missing — the image itself.

## The job

The existing `test` job runs `make check`, the race detector, and a build.
The new `container` job builds the image and starts it:

<!-- verify: .github/workflows/ci.yml at=ci-checks -->
```yaml title=".github/workflows/ci.yml"
  container:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - name: build the image
        run: docker build -f deploy/Dockerfile.dev -t todo:ci .
      - name: smoke the image
        run: |
          docker run -d --name todo -p 8080:8080 \
            -e TODO_ADMIN_EMAIL=admin@example.com \
            -e TODO_ADMIN_KEY=ci-admin-key \
            todo:ci
          for _ in $(seq 1 30); do
            if curl -fsS http://127.0.0.1:8080/ready; then
              exit 0
            fi
            sleep 1
          done
          docker logs todo
          exit 1
```

The build step is the same `Dockerfile.dev` from the container days. The
smoke step starts the image, waits up to thirty seconds for `/ready`, and
prints the container log before failing. The loop is not decoration: a
server that opens its store slowly would fail a single immediate check even
though it is healthy.

The job uses Docker because GitHub's runner has it preinstalled. The commands
are the same as Podman's; only the binary name changes. The image is built
once and used by the smoke step, so a failure points at one artifact.

## Check the checks

Workflow files are YAML with their own schema. A typo in `runs-on` or a step
that names a missing action fails after the job starts. `actionlint` reads
the file and checks it before anything runs:

```bash
$ actionlint .github/workflows/ci.yml
...
```

No output means no findings. Run it locally before pushing; it is faster than
waiting for a runner to tell you about an indentation mistake.

The same commands can be run by hand. Build the image:

```bash
$ podman build -f deploy/Dockerfile.dev -t todo:ci .
...
Successfully tagged localhost/todo:ci
```

Start it with the same environment the workflow uses:

```bash
$ podman run -d --name todo-ci -p 18085:8080 -e TODO_ADMIN_EMAIL=admin@example.com -e TODO_ADMIN_KEY=ci-admin-key todo:ci
78c55aebadccf23c507c1005b7ebf97ee144b162f193a336429c0efba665299e
```

Ask for readiness:

```bash
$ curl -sS http://127.0.0.1:18085/ready
{"status":"ok"}
```

The local run proves the commands. The workflow is what runs them on a clean
machine, from a fresh checkout, with no cache from this laptop. That
difference is the point: a passing local run is evidence, not a guarantee.

## What the job does not do

It does not deploy. It does not publish the image to a registry. It does not
run the Kubernetes manifests or the cloud template. Those are later jobs with
credentials and environments; a check job should be able to run on a fork
with no secrets.

It also does not run the quote and transcript checks, because those read
sibling projects that are private to the author. The book's own checks run
them locally. The app's CI runs the checks that can run anywhere.

## Caching the build

The container job rebuilds the image from scratch on every run. That is correct
and slow: the Go module download and the compile are repeated even when only a
documentation file changed. A registry cache or a BuildKit cache mount makes
the second run faster without changing the result.

The cache is an optimization, not a correctness tool. A cached layer that
hides a missing file is worse than a slow build. The first run after a cache
change should be a clean run; the `--no-cache` flag is the escape hatch. The
same rule applies to the Go test cache: a stale cache can hide a failure that
only appears in a clean environment.

The job also duplicates the Go setup that `test` already does. At this size the
duplication is cheaper than an artifact handoff. At a larger size, the build
job produces the binary once, uploads it, and the container job copies it; the
artifact is the unit of trust, and the digest is its name.

## What runs locally and what runs in CI

The local check runs the quote and transcript checks because those read the
private sibling projects. CI cannot run them, so it runs the checks that need
only this project: the Go suite, the race detector, the build, the container
smoke, and the bench check. The split is deliberate: a fork can run CI, and the
author's machine runs the full book check.

The two checks share the commands they can. `make check` is the app's local
check; `bun run check` is the book's. A failure in either names the command to
run again. The important rule is that the release candidate passes both, not
just the one that is convenient.

## Secrets in CI

The smoke job uses a fake admin key in the command. That is fine because the
container is ephemeral and the key guards nothing. A job that talks to a real
environment gets its secrets from the environment, never from the YAML, and
never prints them even on failure.

A pull request from a fork does not receive the project's secrets. That is a
feature: the check job must be runnable without them. The deploy job is the one
that needs the environment and its reviewers, and it is a separate workflow for
exactly that reason.

## If something went wrong

- **`actionlint` reports `shellcheck` warnings** — the embedded shell script
  has an unused variable or an unquoted expansion. Fix the script; the
  workflow YAML is fine.
- **The smoke step times out** — read the `docker logs todo` output the step
  prints. A missing admin email or a bad store path is the usual cause; the
  app exits before `/ready` can answer.
- **`docker: command not found`** — the job is running somewhere without
  Docker. The runner image provides it; a self-hosted runner needs it
  installed.
- **The image builds locally but not in CI** — the local build used a cache
  or a file excluded by `.dockerignore`. Run `docker build --no-cache` once
  to see the clean path.

<details>
<summary>Going deeper: why the image is a separate job</summary>

The Go checks and the container check fail for different reasons. A unit
test catches a logic error; the image check catches a missing runtime
library, a broken Dockerfile, or a server that cannot start. Keeping them in
separate jobs makes the failure legible and lets them run in parallel.

The trade-off is duplicate setup: both jobs check out the project and
install Go. A larger project would build the binary once, upload it as an
artifact, and have the image job consume it. That is the same "build once,
promote the artifact" idea the deploy day uses. For this size, the duplicate
setup is cheaper than the coordination.

</details>

The checks are in place. Next we let a passing change deploy itself, with a
smoke test and a rollback that a human can trigger.

<div class="day-tracker" data-day="70"></div>
