---
title: ".github — the finished app"
sidebar:
  hidden: true
tableOfContents: false
pagefind: false
---


Part of [The finished app (spoilers)](/100-days-of-go-lang/appendices/the-finished-app/).


## `.github/workflows/ci.yml`

````yaml
name: ci

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          # The secrets scan is over the history; a shallow checkout would
          # scan one commit and pass vacuously.
          fetch-depth: 0
      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
          cache: true
      - name: check
        run: make check
      - name: race
        run: make race
      - name: build
        run: go build ./...

  bench:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          # The gate builds a test binary from the revision each baseline
          # names in its control-ref header, so the history has to be here.
          fetch-depth: 0
      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
          cache: true
      # The gate compares the working tree against a control revision built
      # and run in the same job, so the runner's hardware does not matter:
      # both sides ran there. It is the allocation budgets and the paired
      # time comparison that travel; the committed baseline files are the
      # record, not the comparison.
      - name: bench gate
        run: make bench-gate
````


## `.github/workflows/deploy.yml`

````yaml
# deploy.yml — the first CD step: a deploy that a human dispatches, gated by
# an environment, shipped over ssh. It takes effect once a remote and the
# production environment's secrets exist; until then the file documents the
# pipeline, and deploy/RUNBOOK.md's manual procedure is the same steps by
# hand.
#
# The shape, and why:
#
#   - workflow_dispatch, not push: a deploy is a decision, and the button is
#     the decision's record. The `ref` input defaults to main and can name a
#     tag for a rollback (the previous binary is what a rollback installs;
#     see the runbook).
#   - environment: production, where the repository's secrets live and where
#     required reviewers are configured. A workflow cannot name a secret the
#     environment does not grant it, so the environment is the gate, not the
#     YAML.
#   - `make check` before the build: the deployed artifact is built from a
#     tree the same gate passed, and the gate is the same one CI runs — a
#     dispatch on an old ref gets the same honesty machine as a push.
#   - CGO_ENABLED=0: the binary the release will ship is the binary the
#     deploy ships (chapter 49 makes that literal).
#   - The key is written to a file with mode 600 and the host key comes from
#     a secret, not ssh-keyscan: trust-on-first-use would accept whatever
#     answers the first connection, which is the one thing an ssh key is
#     supposed to prevent.
#   - The restart is followed by a readiness check through the app's own
#     /ready, over the loopback the unit binds: a deploy that shipped a
#     binary that cannot serve its database fails here, loudly.
#
# The four secrets: DEPLOY_HOST (the hostname), DEPLOY_USER (an account with
# sudo for the install and the restart), DEPLOY_SSH_KEY (its private key),
# DEPLOY_KNOWN_HOSTS (the host key line, from the runbook's `ssh-keyscan`).

name: deploy

on:
  workflow_dispatch:
    inputs:
      ref:
        description: ref to deploy (a branch or tag)
        default: main
        required: false

# One deploy at a time, and no cancel-in-progress: cancelling mid-ship would
# leave the host in a state nobody chose.
concurrency:
  group: deploy-production
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v5
        with:
          ref: ${{ inputs.ref }}
          # The gate scans the whole history (gitleaks), so the clone is
          # deep; a shallow one would scan one commit and pass vacuously.
          fetch-depth: 0
      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
          cache: true
      - name: gate
        run: make check
      - name: build
        run: CGO_ENABLED=0 go build -trimpath -o dist/todo-server ./cmd/todo-server
      - name: install the key
        env:
          DEPLOY_SSH_KEY: ${{ secrets.DEPLOY_SSH_KEY }}
          DEPLOY_KNOWN_HOSTS: ${{ secrets.DEPLOY_KNOWN_HOSTS }}
        run: |
          install -d -m 700 ~/.ssh
          printf '%s\n' "$DEPLOY_SSH_KEY" > ~/.ssh/deploy_key
          printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > ~/.ssh/known_hosts
          chmod 600 ~/.ssh/deploy_key ~/.ssh/known_hosts
      - name: ship
        env:
          DEPLOY_HOST: ${{ secrets.DEPLOY_HOST }}
          DEPLOY_USER: ${{ secrets.DEPLOY_USER }}
        run: |
          scp -i ~/.ssh/deploy_key dist/todo-server "$DEPLOY_USER@$DEPLOY_HOST:/tmp/todo-server.new"
      - name: install and restart
        env:
          DEPLOY_HOST: ${{ secrets.DEPLOY_HOST }}
          DEPLOY_USER: ${{ secrets.DEPLOY_USER }}
        run: |
          ssh -i ~/.ssh/deploy_key "$DEPLOY_USER@$DEPLOY_HOST" \
            'sudo install -m 0755 /tmp/todo-server.new /usr/local/bin/todo-server && rm -f /tmp/todo-server.new && sudo systemctl restart todo-server'
      - name: check
        env:
          DEPLOY_HOST: ${{ secrets.DEPLOY_HOST }}
          DEPLOY_USER: ${{ secrets.DEPLOY_USER }}
        run: |
          ssh -i ~/.ssh/deploy_key "$DEPLOY_USER@$DEPLOY_HOST" \
            'curl -fsS http://127.0.0.1:8080/ready'
````


## `.github/workflows/release.yml`

````yaml
# release.yml — the release: a v* tag is the decision, the workflow is the
# record, and what it leaves behind is a draft until a human publishes it.
# It takes effect once a remote exists; until then the file documents the
# pipeline, and `make release-check` is the same pipeline run by hand.
#
# The shape, and why:
#
#   - push on v* tags, not workflow_dispatch: a release is cut from a tag,
#     and the tag is the artifact's name. Nobody spells the version twice —
#     the tag is the version, and the workflow's trigger is the whole
#     filter.
#   - the gate runs first, the same one deploy.yml runs: the released
#     artifact is built from a tree the honesty machine passed. A tag can
#     point at a commit older than main's tip, so the gate re-checks the
#     tree the tag actually names.
#   - fetch-depth: 0: GoReleaser walks the history between the tag and the
#     previous one to write the changelog, and the gate's secrets scan
#     reads every commit — a shallow clone would quietly hollow out both.
#   - make release, not a bare goreleaser: the version pin lives in the
#     Makefile, once, and the workflow runs the same command a laptop runs.
#   - the login is the one thing the local run does not have: the image is
#     pushed to ghcr.io under the repository's own token. `make
#     release-check` skips the image when no container runtime is present.
#   - contents: write is the draft release and its artifacts; packages:
#     write is the image. Nothing else is asked of the token.
#   - the draft is the point of the last step: the tag can be pushed by a
#     machine, but the release is a decision, and a human reads the
#     changelog and checks the artifacts before the world does.

name: release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write
  packages: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
          cache: true
      - name: gate
        run: make check
      - name: log in to the container registry
        run: echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u "${{ github.actor }}" --password-stdin
      - name: release
        run: make release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
````
