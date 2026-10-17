---
title: "docs — the finished app"
description: "The finished app, file by file: docs (spoilers)."
sidebar:
  hidden: true
tableOfContents: false
pagefind: false
---


Part of [The finished app (spoilers)](/100-days-of-go-lang/appendices/the-finished-app/).


## `docs/threat-model.md`

````markdown
# Threat model

This is the audit's document: what the application protects, who can reach
it, where the trust boundaries are, and which threats the controls answer.
The mapping is to OWASP ASVS 5.0, in the four chapters this application's
surface lives in: **V4 API and Web Service**, **V6 Authentication**, **V7
Session Management**, **V8 Authorization**. The machine-checked half of the
audit lives beside it — `govulncheck`, `gitleaks`, the dependency allowlist
and the bill of materials (`internal/audit`), the lint config — and this
document is the human half: the decisions those tools cannot read.

It is a snapshot of the tree the `audit` checkpoint names. It is not a
compliance claim: every requirement below is marked *met*, *partial*, *gap*,
or *n/a* with a reason, and the gaps are listed rather than glossed. The
deployment chapter (48) moves some boundaries — TLS, the proxy, systemd's
credentials — and those moves are named where they land.

## The system and its boundaries

Three binaries share one domain: `todo` (CLI), `todo-server` (JSON API and
server-rendered pages on one echo instance), `todo-tui` (an API client). The
server is one process over one SQLite-compatible database file (Turso, no
cgo). The boundaries, from the outside in:

1. **The network.** The server binds `127.0.0.1:8080` by default — loopback
   until an operator says otherwise (`internal/config`). The process speaks
   plain HTTP; TLS, the public listener, and the proxy are the deployment's
   (chapter 48). HSTS is emitted only when the request's scheme is https,
   and echo believes a forwarded scheme only from a trusted peer
   (`internal/api/middleware.go`).
2. **The browser session.** One `__Host-session` cookie carries a reference
   token; the form edge adds a per-session CSRF token. The JSON edge relies
   on the cookie policy plus the same-origin stance (`internal/web/csrf.go`).
3. **The operator.** The first admin arrives through `TODO_ADMIN_KEY` (or
   `TODO_ADMIN_KEY_FILE`), loaded before anything opens a file and stored as
   an argon2id hash; systemd's `LoadCredential=` is the same file with a
   stricter mode (chapter 46, chapter 48).
4. **The database file.** Local, unencrypted, and the whole state: task
   rows, password hashes, hashed session tokens, the audit trail. Anyone who
   can read the file reads task data and material to crack, not credentials
   to replay.
5. **The repository and the supply chain.** The history is forever
   (`make leaks`); the module graph is allowlisted and inventoried
   (`internal/audit`, `docs/sbom.cdx.json`); tools are pinned as
   `go run …@version` (Makefile).
6. **The process's own memory.** Logs and profiles: the profiles sit behind
   `RequireUser` and `RequireAdmin` because memory can hold anything
   (`internal/api/api.go`); log records are built from an attribute
   discipline and a redacting type (`internal/secret`).

## Assets

| Asset | Where it lives | What protects it |
|---|---|---|
| Task data | `tasks` rows | ownership scoping in the queries; foreign reads answer 404 |
| Password hashes | `users.password_hash` (PHC argon2id) | one-way hash; never serialized; `grep -rn 'Reveal()'` audits the exits |
| Admin key | operator's environment / file / systemd credential | owner-only mode bits; argon2id hash at rest; `secret.Secret` redaction; never in `Config` |
| Session tokens | cookie (reference token) and `sessions` table (SHA-256 digest) | `__Host-` prefix, Secure, HttpOnly, SameSite=Lax; 24 h absolute lifetime; renewed at login |
| CSRF token | session payload | one per session; constant-time compare; rotated with the session at login |
| Audit trail | `audit_events` | written in the same transaction as the change it records; never rewritten |
| Log records | stderr (tint/JSON) and the XDG state file | no secrets by type; request and trace ids for correlation |
| Profiles | `/debug/pprof` | `RequireUser` + `RequireAdmin`, flag read per request |
| Supply chain | `go.mod`, `go.sum`, allowlist, SBOM | `govulncheck`, `gitleaks`, the allowlist test, the SBOM test, pinned tools |

## Actors

- **Anonymous caller** — can reach the health endpoints, the auth routes,
  the spec and its UI, and every refusal.
- **Registered user** — owns their tasks; every store view is scoped to
  them; no user can read or write another's tasks.
- **Admin** — a user with the flag; reaches the profiles. The flag is read
  from the database on every gated request, so a grant or revoke lands on
  the next request.
- **Local operator** — shell access to the machine: sets the key, runs the
  CLI's `admin grant`, can read the database file. Outside the process's
  trust boundary by construction; the app's job is to leave them as little
  as possible (a hash, not a key).
- **A reader of a stolen copy** — the database file, a log file, a clone of
  the history. The design goal: a copy yields material to crack and data to
  read, but no credential to replay and no secret to harvest.
- **The dependency ecosystem** — every module in the graph is code that runs
  in this process.

## Threats and controls

| Threat | Control | Evidence |
|---|---|---|
| Credential stuffing, brute force | one token bucket per source address, shared by both login edges; every attempt costs ~19 ms of argon2id | `internal/api/ratelimit.go`; `TestLoginLimiter_OneBudgetAcrossEdges`, `TestLoginLimiter_429` |
| Account enumeration | one sentinel for both failures; an unknown email is verified against a dummy hash so timing matches | `internal/auth/auth.go`; `TestLogin_WrongPassword`, `TestLogin_EmptyCredentials` |
| Session theft | reference token, digest at rest, `__Host-` + Secure + HttpOnly + SameSite=Lax, fixed 24 h lifetime | `internal/api/sessions.go`, `internal/auth/session.go`; `TestSessionCookie_HostPrefix`, `TestSessionStore_HashesTokenAtRest` |
| Session fixation | the token is re-issued at login; the CSRF token rotates with it | `internal/api/auth.go`; `TestLogin_RenewsSessionAndCSRFToken` |
| IDOR / BOLA (a foreign task) | the scope lives in the queries; a foreign id answers exactly what a missing id answers | `internal/api/authorization.go`; `TestTask_Foreign_Returns404` |
| Privilege escalation to the profiles | `RequireAdmin` reads the flag from the database per request; an authenticated non-admin gets a named 403 | `internal/api/authorization.go`; `TestPprof_RequiresAdmin` |
| CSRF on the form edge | synchronizer token, constant-time compare, refusal before any handler runs | `internal/web/csrf.go`; `TestCSRF_LoginFormCarriesTheToken` |
| XSS | no JavaScript anywhere; templ escapes by construction; CSP `script-src 'none'` (the docs UI has its own, confined policy) | `internal/api/middleware.go`; `TestCSP_Snapshot`, `TestCSP_SwaggerUI`, `TestIndexPage_RendersTasks` |
| Clickjacking | `frame-ancestors 'none'` and `X-Frame-Options: DENY`, pinned together | `TestSecurityHeaders` |
| MIME sniffing | `X-Content-Type-Options: nosniff`; every response names its type | `TestSecurityHeaders`, `internal/web/web.go` |
| Request-body DoS | 64 KiB body limit (Content-Length and a counting reader), 10 s deadline, gzip threshold, 64-char request-id cap | `internal/api/middleware.go`; `TestTimeout_504`, `TestCreateTask_UnusableBody` |
| Header spoofing | the limiter keys on the transport peer, not `RealIP`; forwarded headers are trusted only from trusted peers | `internal/api/ratelimit.go`; `TestHSTS` |
| Panic as an outage or leak | `Recover` returns the error into the one handler; the stack stays in the process | `TestPanic_Recovered` |
| Error-message leakage | one JSON error shape; internal failures log their text and answer a fixed message | `internal/api/error.go` |
| Unreadiness misreported as health | `/healthz` touches nothing; `/ready` pings the store and answers 503 | `TestHealthz`, `TestReady_StoreDown` |
| Secret in a log, a string, or a document | `secret.Secret` closes `String`, `GoString`, `LogValue`, `MarshalText`; one `Reveal` exit | `internal/secret`; `TestSecret_Redacts`, `TestSecret_ProcessLogger` |
| Secret in the git history | `gitleaks` over every commit, in the gate and in CI (deep checkout) | `make leaks`; clean over the full history (the count moves with every commit) |
| Vulnerable dependency | `govulncheck` over the module; the finding it reports at module level is unreachable code | `make vulncheck`; 0 vulnerabilities found, 1 module-level advisory not called |
| Rogue direct dependency | the allowlist test refuses a direct requirement with no documented reason | `internal/audit`; `TestDependenciesAreAllowlisted` |
| Stale bill of materials | the SBOM test checks the committed document against `go.mod` in both directions | `internal/audit`; `TestSBOMNamesEveryRequirement` |
| Undocumented lint suppression | every `#nosec` must carry its reason; generated files are excluded | `internal/audit`; `TestSuppressionsCarryReasons` |
| Lost update / stale write | version compare-and-swap on every write; a stale snapshot is a 409 | `internal/store`; `TestConcurrentUpdates_Conflict` |
| Corrupt import / half-written export | atomic export write; bounded, transactional import | `TestWriteExportFile_FailedWriteKeepsOldFile`, `TestImportJSON_Atomic` |

## ASVS 5.0 mapping

Status: **met** (control present and tested), **partial** (present with a
named limitation), **gap** (absent; listed in Residual risks), **n/a** (the
mechanism does not exist here). Levels follow ASVS 5.0's own; the
application claims full L1 coverage and names its L2/L3 gaps rather than
implying them.

### V4 API and Web Service

| ID | Requirement (short) | Status | Where |
|---|---|---|---|
| 4.1.1 | responses carry a Content-Type matching their content | met | echo's serializer (`application/json`); pages set `text/html; charset=utf-8` (`internal/web/web.go`); assets serve `text/css`; the error handler writes through `c.JSON` |
| 4.1.2 | only user-facing endpoints redirect http→https | n/a | nothing redirects; TLS belongs to the deployment (ch 48) |
| 4.1.3 | intermediary headers not overridable by the end user | met | the login limiter keys on the transport peer; echo's trusted-peer rule for forwarded headers (ch 48 owns the proxy configuration) |
| 4.1.4 | only explicitly supported methods | met | the route table is explicit; unused methods answer 405 in the one error shape (`codeForStatus`) |
| 4.1.5 | per-message digital signatures | n/a | no cross-system, high-value transactions |
| 4.2.1–4.2.4 | HTTP framing, smuggling, CRLF injection | met | `net/http` parses both edges; the application never re-frames messages and speaks one HTTP version |
| 4.2.5 | bounded URI/header construction | partial | request bodies are capped at 64 KiB and `X-Request-ID` at 64 chars; the URI and header block are bounded by `net/http`'s defaults, not by an explicit application limit |
| 4.3 | GraphQL controls | n/a | no GraphQL |
| 4.4 | WebSocket controls | n/a | no WebSocket |

### V6 Authentication

| ID | Requirement (short) | Status | Where |
|---|---|---|---|
| 6.1.1 | rate limiting / anti-automation documented | met | this document; `internal/api/ratelimit.go` (one budget per source, both edges, no lockout) |
| 6.1.2 | context-specific password blocklist documented | gap | none exists; registration enforces length only |
| 6.1.3 | multiple authentication pathways documented and consistently enforced | met | the JSON and form edges share one `auth.Service`; documented in `internal/web/auth.go` and here |
| 6.2.1 | passwords ≥ 8 characters | met | `registerRequest` (`validate:"min=8,max=128"`); 15 is recommended by ASVS and not enforced |
| 6.2.2 | users can change their password | gap | no change flow; the operator's key rotation (ch 46) is the only credential write |
| 6.2.3 | change requires current and new password | n/a | no change flow |
| 6.2.4 | top-3000 password check | gap | none |
| 6.2.5 | no composition rules | met | only length is enforced |
| 6.2.6 | password input masked | met | `type="password"` (`internal/web/views/login.templ`) |
| 6.2.7 | paste and password managers permitted | met | nothing interferes; the pages carry no JavaScript |
| 6.2.8 | password verified exactly as received | met | argon2id over the exact bytes; no trimming or transformation (`internal/auth/password.go`) |
| 6.2.9 | passwords ≥ 64 characters permitted | met | registration allows 128; login has no cap |
| 6.2.10 | no periodic rotation | met | nothing rotates user passwords; the admin key changes only when the operator changes it |
| 6.2.11 | context-specific words rejected | gap | as 6.1.2 |
| 6.2.12 | breached-password check | gap | none |
| 6.3.1 | anti-automation implemented | met | `internal/api/ratelimit.go`; `TestLoginLimiter_OneBudgetAcrossEdges` |
| 6.3.2 | no default accounts | met | no seeded users; the admin exists only when the operator sets a key; `TestServer_AdminKeyBootstrap` |
| 6.3.3 | MFA or a combination of factors | gap | single-factor passwords; L2 is not claimed |
| 6.3.4 | no undocumented pathways | met | register, login, logout; two edges over one service |
| 6.3.5 | notify on suspicious authentication | gap | the trail records logins; nothing notifies |
| 6.3.6 | email not used as a factor | met | email is an identifier; the factor is the password |
| 6.3.7 | notify on credential updates | gap | none |
| 6.3.8 | valid users not deducible from failures | met | one sentinel, dummy-hash timing, identical bodies; `TestLogin_WrongPassword` |
| 6.4.1 | generated initial passwords expire | n/a | the bootstrap key is operator-supplied, not generated (ch 46 records the choice) |
| 6.4.2 | no password hints or secret questions | met | none exist |
| 6.4.3 | secure password reset | gap | no reset flow; a lost password is an operator rotation |
| 6.4.4–6.4.6 | MFA loss, expiring factors, admin reset | n/a | no MFA, no expiring factors |
| 6.5–6.8 | MFA mechanisms, out-of-band, cryptographic factors, IdPs | n/a | none of these mechanisms exist |

### V7 Session Management

| ID | Requirement (short) | Status | Where |
|---|---|---|---|
| 7.1.1 | inactivity and absolute lifetime documented | partial | the absolute lifetime is 24 h and documented (`internal/api/sessions.go`); there is no inactivity timeout — the deviation is named here rather than hidden |
| 7.1.2 | concurrent sessions documented | gap | sessions are unlimited; nothing counts or caps them |
| 7.1.3 | federated session management documented | n/a | no federation |
| 7.2.1 | token verification at a trusted backend | met | scs loads every token through the SQLite store (`internal/auth/session.go`) |
| 7.2.2 | dynamically generated reference tokens | met | per-session tokens from scs; no static secrets |
| 7.2.3 | CSPRNG, ≥ 128 bits | met | scs draws 32 bytes from `crypto/rand` (256 bits) — see the `hashToken` comment in `internal/auth/session.go` |
| 7.2.4 | new token at authentication | met | `RenewToken` at login; `TestLogin_RenewsSessionAndCSRFToken` |
| 7.3.1 | inactivity timeout | gap | none; see 7.1.1 |
| 7.3.2 | absolute maximum lifetime | met | 24 h; the expiry predicate is in the query, so an expired row is invisible before any sweep; `TestSessionStore_ExpiredIsNotFound` |
| 7.4.1 | termination disallows further use | met | logout deletes the row; `TestLogout` |
| 7.4.2 | terminate sessions when an account is disabled or deleted | n/a | no account disable or delete exists |
| 7.4.3 | terminate other sessions after a credential change | gap | no flow exists (ch 46 names it for the key rotation too) |
| 7.4.4 | logout reachable on authenticated pages | met | the layout's logout form (`internal/web/views/layout.templ`) |
| 7.4.5 | admins can terminate a user's sessions | gap | none; the boot sweep removes only expired rows |
| 7.5.1 | re-authentication for sensitive attribute changes | n/a | no such attributes are editable |
| 7.5.2 | view and terminate active sessions | gap | none |
| 7.5.3 | step-up authentication for sensitive operations | n/a | no operations beyond ordinary CRUD |
| 7.6 | federated re-authentication | n/a | no federation |

### V8 Authorization

| ID | Requirement (short) | Status | Where |
|---|---|---|---|
| 8.1.1 | function- and data-level rules documented | met | this document; `internal/api/authorization.go`; the scope lives in the queries |
| 8.1.2 | field-level rules documented | met | `userResponse` carries id, email, created_at, is_admin only; the hash has no field (`internal/api/auth.go`) |
| 8.1.3 | environmental attributes documented | met | the login limiter keys on the source address; no other environment decides |
| 8.1.4 | adaptive controls documented and implemented | gap | none beyond the limiter; L3 is not claimed |
| 8.2.1 | function-level access explicit | met | `RequireUser` on tasks and pages; `RequireAdmin` on the profiles |
| 8.2.2 | data-specific access (IDOR/BOLA) | met | every query scoped to the session's user; foreign reads answer 404; `TestTask_Foreign_Returns404` |
| 8.2.3 | field-level access | met | DTOs at both edges; the password hash never leaves the process (`TestTaskRoutes_RequireUser`) |
| 8.2.4 | adaptive controls | gap | as 8.1.4 |
| 8.3.1 | enforced at a trusted layer | met | gates and scoping are server-side; the TUI holds no privilege of its own |
| 8.3.2 | authorization changes apply immediately | met | the admin flag is read per request, never carried in the session; `TestPprof_RequiresAdmin` |
| 8.3.3 | the originating subject's permissions | met | one service; no delegation or service-to-service tokens |
| 8.4.1 | cross-tenant controls | n/a | single-tenant: users own tasks, and there is no tenant layer |
| 8.4.2 | administrative interfaces multi-layered | partial | the profiles require a live session and a flag read from the database; there is no device posture or risk analysis (L3) |

## Supply chain and the repository

- **Secrets never in git.** `gitleaks` scans every commit, not the working
  tree, because a key that reached a commit reached every clone (`make
  leaks`; the scan is clean at this checkpoint). The design that keeps it
  that way: credentials are hashed at rest (argon2id for passwords and the
  admin key, SHA-256 for session tokens), the admin key is loaded into a
  redacting type before anything opens a file, and no secret enters a
  `Config`.
- **Least-privilege tokens.** No workflow, script, or document in this
  repository holds a credential, and the CI workflow requests no elevated
  permissions — it runs with the repository's default token and nothing
  else. When a remote and releases arrive (chapters 48–49), the policy is
  the same one the deployment will use: a token is scoped to the single
  action it performs, written into a secret store the process can read, and
  never echoed into a log.
- **Dependency policy.** Every direct requirement is on the allowlist with
  its reason (`internal/audit/deps.go`); the bill of materials pins the
  whole graph, direct and indirect, and the test checks it against `go.mod`
  in both directions (`docs/sbom.cdx.json`). Updates arrive as explicit
  edits: a bump satisfies the allowlist test unchanged, a new module needs
  its reason, and the SBOM is regenerated with `make sbom`. Once a remote
  exists, Dependabot or Renovate raises the bumps and the workflows run
  exactly these checks; the bot is the messenger, not the authority.
- **Vulnerability and lint checks.** `make vulncheck` runs `govulncheck`
  v1.9.0 over the module; `make lint` runs golangci-lint v2.14.0 with
  staticcheck's full check set and gosec unfiltered; both run in `make
  check` and in the workflows. Tools are pinned as `go run …@version` in
  the Makefile —
  the same block CI reads.

## Residual risks

Named, not fixed, at this checkpoint:

1. **No MFA, no password change or recovery.** A stolen password is a full
   account compromise until the operator rotates it.
2. **No inactivity timeout.** A session lives its fixed 24 h however idle;
   a stolen cookie is usable for that window.
3. **Sessions are unlimited and unmanageable.** No list, no revoke, no cap
   per account; the boot sweep removes only expired rows.
4. **The database file is unencrypted.** A stolen copy yields task data and
   hashes to crack. Backups (ch 48) inherit this.
5. **No rate limit beyond the login edges.** Task routes and the spec have
   only the 10 s deadline and the body limit.
6. **`GO-2026-5932` (x/crypto/openpgp) is unfixable at module level.** The
   package is unmaintained; the application imports `argon2` from the same
   module and never `openpgp`, and `govulncheck`'s symbol analysis is what
   says so — the module-level report is recorded rather than hidden.
7. **A client-supplied `X-Request-ID` is trusted, bounded.** It reaches
   records and the response header, capped at 64 characters; it names
   nothing.
8. **HSTS and TLS depend on the deployment.** The process sets HSTS only
   when the scheme is https; until chapter 48's proxy, that scheme never
   arrives.
9. **The profiles are powerful.** Gating them is the right call and the
   process's memory is still what they hand out; the admin flag is the only
   lock.

## What chapter 48 changes

TLS termination and the public listener (Caddy), echo's `IPExtractor`
configured once at the proxy so the limiter keeps keying on the real peer,
systemd's `LoadCredential` as the key's home with the mode the loader
already accepts, `MemoryMax` on the unit, and backups for the single
database file. None of those moves a gate — they move the boundary the gate
already assumes.
````
