---
title: Security at scale
day: 89
time: "3 hours"
description: Redraw the threat model, scan the supply chain, and plan the rotation.
sidebar:
  order: 75
---

The first audit covered one process, one database file, and one browser
session. The production ground added a service boundary, a broker, a cache, a
cloud identity, and a public edge. Every one of those is a new place to stand
on the other side of a check.

A **threat model** is the list of those places, the assets that cross them,
and the controls that answer. It is not a compliance certificate. It is a
document you can argue with, and the arguments are the useful part.

Today we redraw the model for the split system, run the supply-chain scans,
and rotate the admin key.

## The new boundaries

The model starts with the boundaries, from the outside in:

<!-- verify: docs/threat-model-production.md at=security-scale -->
```markdown title="docs/threat-model-production.md"
1. **The public edge.** Caddy, an Ingress, or a cloud load balancer terminates
   TLS and forwards to the API. The API trusts a forwarded client address only
   from that peer. The WebSocket upgrade crosses the same edge and needs its
   own origin check.
2. **The API.** Owns authentication, authorization, task validation, and the
   task database. It is the only writer of tasks.
3. **The activity service.** A separate process with its own HTTP, gRPC, and
   WebSocket listeners. It owns the feed projection, not the tasks. It must
   not read the task database directly.
4. **Kafka.** Carries task events. Producers write with the task id as the key;
   consumers read in a group. The broker is a new unauthenticated network
   service unless SASL/TLS is configured.
5. **Redis.** Caches the feed and holds rate-limit counters. It is
   unauthenticated by default and must not be reachable from the public
   network.
```

The activity service is the interesting one. It is a new process with a new
public socket, but it does not own the task data. If it read the tasks table
directly, it would be a second owner of the schema and a second path around the
API's authorization. The event stream keeps the ownership one-way.

Kafka and Redis are internal services that are unauthenticated in the local
lab. That is acceptable on a loopback network and unacceptable in a cloud. The
model marks them and the cloud chapters name the managed equivalents.

## The assets

The table pairs each asset with the boundary it crosses and the control that
answers:

<!-- verify: docs/threat-model-production.md at=security-scale -->
```markdown title="docs/threat-model-production.md"
| Asset | Boundary | Control | Status |
|---|---|---|---|
| Task rows | API → PostgreSQL | owner-scoped queries, TLS, least-privilege role | met when `TODO_POSTGRES_DSN` is set; Turso is the default |
| Session cookie | edge → API | `__Host-`, Secure, HttpOnly, SameSite | met |
| Admin key | cloud → task | SSM SecureString, execution role, rotation | met in the local emulator; KMS policy not exercised |
| Event stream | producer → Kafka | task-id key, at-least-once, idempotent consumer | met; the API task handlers are not wired yet |
| Feed cache | activity → Redis | TTL, delete-on-write, private network | partial — Redis has no auth in the lab |
| WebSocket | browser → activity | origin allowlist, session check | gap — the local lesson disables the origin check |
```

The `partial` and `gap` entries are the point. A model that marks everything
`met` is a marketing page. The WebSocket gap is real: the local lesson uses
`InsecureSkipVerify` so a command-line client can connect; a browser-facing
deployment must validate `Origin` against an allowlist.

## The new threats

The event stream adds forgery and replay. The cache adds poisoning. The cloud
adds identity and secret sprawl. The socket adds a room that receives every
event.

- **Forged event.** The producer authenticates to Kafka with SASL; the topic
  ACL allows only the API identity to write. The activity service is a reader.
- **Replayed event.** At-least-once delivery can repeat a record; the consumer
  keys by event id. A forged id is a producer compromise, not a replay.
- **Poisoned cache.** Delete-on-write plus a short TTL bounds the window.
  Redis is private and authenticated in production.
- **Public broker.** Kafka and Redis exposed to the internet are the two most
  common mistakes in this stack. The network policy and the security group
  deny ingress from outside.
- **Socket without origin check.** The handshake validates `Origin`; the
  local `InsecureSkipVerify` is not a production setting.

## The scans

The machine-checked half is three commands:

```bash
$ make vulncheck
No vulnerabilities found.

Your code is affected by 0 vulnerabilities.
This scan also found 0 vulnerabilities in packages you import and 3
vulnerabilities in modules you require, but your code doesn't appear to call
these vulnerabilities.
Use '-show verbose' for more details.
```

`govulncheck` reports vulnerabilities the code actually calls. The three
module-level findings are in code paths the app does not reach; the tool says
so rather than hiding them. The release check keeps the scan; a finding that
becomes reachable fails the check.

The history scan:

```bash
$ make leaks
...
3:23PM INF 324 commits scanned.
3:23PM INF scanned ~4073157 bytes (4.07 MB) in 591ms
3:23PM INF no leaks found
```

`gitleaks` scans every commit, not the working tree. A secret removed in a
later commit is still in the history; the scan is the only thing that sees it.
The book's project is public, so a leak would be a real incident, not a
lint warning.

The dependency allowlist and the SBOM are the third check:

```bash
$ go test ./internal/audit
ok  	todo/internal/audit
```

A new direct dependency must be added to the allowlist with a reason; the SBOM
must name every requirement. The test is the policy, not a report.

## Rotate the key

The admin key is a bootstrap credential. Rotation is `aws ssm put-parameter
--name /todo/admin-key --type SecureString --value <new> --overwrite`, then a
task replacement. The running task keeps the old value until it restarts; a
new task reads the new one. The application treats the key as a startup credential, not a
per-request password, so the window is a deploy, not a request.

A real rotation is two people and an audit trail: one proposes, one approves,
the secret manager writes, the deploy replaces the tasks, and the old key is
revoked. The script is the mechanism; the policy is the control.

## If something went wrong

- **`govulncheck` finds a reachable vulnerability** — update the module or
  remove the call path. A suppression without a reason is a gap, not a fix.
- **`gitleaks` finds a secret** — rotate it before rewriting history. The
  secret is compromised the moment it is pushed; removing the commit does not
  un-compromise it.
- **The allowlist test fails** — a direct dependency arrived without a reason.
  Add the module and the reason, or remove it.
- **The WebSocket accepts any origin** — `InsecureSkipVerify` reached
  production. Set the allowlist and rebuild; the check is in the handshake.

<details>
<summary>Going deeper: trust boundaries are where authentication changes</summary>

A trust boundary is not a network diagram line. It is a place where the
identity of the caller changes, or where a claim stops being verifiable. The
public edge authenticates a user; the API trusts a forwarded address only from
the proxy; the activity service trusts an event only because Kafka authenticated
its producer.

Every boundary needs an answer to "who is allowed to cross, and how do we
know?" A boundary without an answer is a hole. The threat model's table is that
answer, one row at a time.

</details>

The system has a threat model, a scan, and a rotation path. The last day is a
drill: break one dependency, watch what notices, and put it back.
