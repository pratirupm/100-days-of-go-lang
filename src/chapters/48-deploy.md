---
title: Deploying
day: 57
time: "3 hours"
description: Put the server on a real machine — a unit that keeps it running, a proxy that faces the internet, and a backup that runs itself.
sidebar:
  order: 48
---

Until now, the app has only ever run on our own machine, started by hand from a terminal. Close the laptop and it stops. A **server** is a computer that stays on and reachable, so the app keeps answering when we are not there.

Linux machines have a supervisor called **systemd**: it starts programs, watches them, and restarts them when they fall over. A **unit** is the small file that tells systemd how to run one program — what to start, what the program may touch, and how to stop it cleanly.

The app should not face the internet directly. A **reverse proxy** is a program that stands at the front door: it answers the public address, handles the encryption, and passes each request to our app behind it.

Today the app gets all three — a unit, a proxy, and a backup that runs on a schedule. The files go in a new folder called `deploy`, and a runbook ties them together.

## The tests come first

The changes this lesson makes are small — a budget, a signal, an address — and the tests come before them, as always. Three files hold the contract: `cmd/todo-server/drain_test.go` for the stop signal, `internal/api/security_test.go` for the address the login limiter keys on, and `cmd/todo-server/backup_test.go` for the backup job's copy.

The drain's last case is one comparison: the budget must outlast the deadline the stack puts on every request.

<!-- verify: cmd/todo-server/drain_test.go at=deploy -->
```go title="cmd/todo-server/drain_test.go"
	t.Run("the drain budget outlasts the request deadline", func(t *testing.T) {
		t.Parallel()

		// internal/api arms a ten-second deadline on every request (its
		// requestTimeout); a request that was in flight when the signal
		// arrived can have that whole deadline left to run. A drain budget
		// below it cuts work the stack would still have served — and exits
		// non-zero, which a supervisor reads as a failed stop.
		assert.GreaterOrEqual(t, shutdownTimeout, 10*time.Second,
			"the drain must outlast internal/api's request deadline")
	})
```

`shutdownTimeout` is how long the server keeps serving after a stop signal, and the test says it must be at least ten seconds — the request deadline.

The trust case spends one client's five login attempts through the proxy, then asks a second client for its own budget.

<!-- verify: internal/api/security_test.go at=deploy -->
```go title="internal/api/security_test.go"
	// The sixth attempt from the same client — a different claim, the same
	// forwarded address — is refused: the bucket is the forwarded client's.
	refused := loginFrom(t, e, "127.0.0.1:5555", "203.0.113.99, 198.51.100.9")
	require.Equal(t, http.StatusTooManyRequests, refused.Code)

	// A second client behind the same proxy still has its own budget. If
	// ...
	other := loginFrom(t, e, "127.0.0.1:5555", "198.51.100.10")
	assert.Equal(t, http.StatusUnauthorized, other.Code)
```

One client's attempts are refused; the second client is not. Today the limiter counts by the socket the request arrived on, and behind a proxy that socket is always the same — so the whole internet shares one budget, and the second client would be refused too.

The backup case restores the copy the job writes, through a scratch store scoped to the user whose tasks it must hold.

<!-- verify: cmd/todo-server/backup_test.go at=deploy -->
```go title="cmd/todo-server/backup_test.go"
	tasks, err := restored.Scoped(owner).List(ctx)
	require.NoError(t, err)
	titles := make([]string, 0, len(tasks))
	for _, task := range tasks {
		titles = append(titles, task.Title)
	}
	assert.ElementsMatch(t, []string{"buy milk", "walk the dog"}, titles,
		"the copy holds every task the live database held; stderr:\n%s", srv.stderr.String())
```

The copy must open and hold both tasks. A copy that lost part of the database can still open, so "it opened" is not enough — the rows are the assertion.

Run the server's tests and watch them fail. The drain's budget is the first failure:

```bash
--- FAIL: TestGracefulShutdown_Drains (0.00s)
    --- FAIL: TestGracefulShutdown_Drains/the_drain_budget_outlasts_the_request_deadline (0.00s)
        drain_test.go:145:
            	Error:      	"5s" is not greater than or equal to "10s"
            	Messages:   	the drain must outlast internal/api's request deadline
    --- FAIL: TestGracefulShutdown_Drains/a_second_signal_is_the_operator's_escape_hatch (3.30s)
        drain_test.go:133: a second SIGTERM did not end the drain
FAIL
FAIL	todo/cmd/todo-server	4.765s
```

Both lines are about stopping: the budget is below the deadline, and a second stop signal gets swallowed instead of ending the process.

The backup job does not exist yet, and the test says so in the plainest way a shell can:

```bash
--- FAIL: TestBackupScript_Restores (0.82s)
    backup_test.go:91:
        	Error:      	Received unexpected error:
        	            	exit status 127
        	Messages:   	the backup job failed:
        	            	sh: ../../deploy/todo-backup.sh: No such file or directory
FAIL
```

Nothing is broken. The tests describe an app that does not exist yet.

## Stopping without dropping a request

A supervisor stops a program by sending it a **signal** — a short message the program can hear. The first one systemd sends is **SIGTERM**, and it means "please stop": stop accepting new requests, finish the ones already in flight, then exit.

The server already does that; what this lesson fixes is how long it is willing to wait. The old budget was five seconds. But the stack puts a ten-second deadline on every request, so a request can still have its whole deadline left to run when the signal arrives — and a five-second drain would cut it. A cut request makes the process exit non-zero, which the supervisor reads as a failed stop.

The new budget is derived from that deadline, with a margin:

<!-- verify: cmd/todo-server/main.go at=deploy -->
```go title="cmd/todo-server/main.go"
// shutdownTimeout bounds the drain: how long Shutdown waits for in-flight
// ...
// the stack arms a ten-second deadline on every request (internal/api's
// requestTimeout), so a request that was in flight when the signal arrived
// can have its whole deadline left to run, and a five-second drain cuts work
// the server would still have served — and exits non-zero, which a
// supervisor reads as a failed stop. The budget is that deadline plus a
// five-second margin for the store's checkpoint and the process's last
// records; the unit's TimeoutStopSec outlasts both.
const shutdownTimeout = 15 * time.Second

// flushTimeout bounds the tracer's last export, and it is deliberately not
// the drain's budget: a batch export that has not finished in five seconds
// is not going to, and the requests were served either way.
const flushTimeout = 5 * time.Second
```

Read the numbers as a chain: ten seconds is the request deadline, fifteen is that deadline plus a margin for the last writes, and five is the tracer's own smaller budget — the last telemetry export, which is not worth waiting longer for. The unit we write next gives the process 25 seconds before its own last resort, so the process always finishes first.

There is a second half to a stop — the escape hatch:

<!-- verify: cmd/todo-server/main.go at=deploy -->
```go title="cmd/todo-server/main.go"
	select {
	case <-ctx.Done():
		// The first signal has canceled ctx. Unregistering the handler now
		// is what makes a second signal the escape hatch: it reaches the
		// process with the default disposition and ends a drain that will
		// not finish on its own. systemd's own stop is two-stage one level
		// up — SIGTERM, then SIGKILL after TimeoutStopSec — and this is the
		// same shape for an operator at a terminal or in a container.
		stop()
		logger.Info("shutting down")
```

`stop()` unregisters the part of the program that listens for signals. After the first signal it is gone, so a second signal reaches the process directly and ends a drain that would otherwise run to its full budget. An operator with a stuck process has a way out that does not need the supervisor.

## The unit: the server as a service

A program meant to run all the time is called a **service**, and systemd runs services from unit files. The unit is where the deployment's decisions live: which program to start, where its data goes, which user it runs as, and how much of the machine it may touch.

The top of the unit names the program and its listening address:

<!-- verify: deploy/todo-server.service at=deploy -->
```ini title="deploy/todo-server.service"
[Unit]
Description=Todo API and web server
Documentation=file:/usr/local/share/doc/todo/RUNBOOK.md
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
ExecStart=/usr/local/bin/todo-server --listen 127.0.0.1:8080

# Identity and state. DynamicUser allocates a uid at start and releases it at
# stop: no account to create, no home, nothing to leak into a shell. The two
# directories are the process's whole writable world — StateDirectory=todo is
# /var/lib/todo for the database, LogsDirectory=todo is /var/log/todo for the
# log file — and they are what keeps ProtectSystem=strict from being a
# promise the process cannot keep.
DynamicUser=yes
StateDirectory=todo
StateDirectoryMode=0700
LogsDirectory=todo
Environment=TODO_DB=/var/lib/todo/todo.db
Environment=TODO_LOG=/var/log/todo/todo.log
```

Read the address first: `127.0.0.1:8080` is the machine's own loopback — reachable only by programs on the same machine. The proxy is the only way in, which is why the server can trust the proxy so narrowly later. `DynamicUser=yes` gives the process a throwaway identity, created at start and gone at stop, so there is no account to create and no home to leak into. The two directories are its whole writable world, and they are what lets the rest of the filesystem stay read-only.

The admin credential comes next:

<!-- verify: deploy/todo-server.service at=deploy -->
```ini title="deploy/todo-server.service"
# The admin credential. LoadCredential copies /etc/todo/admin-key — the
# operator's file, root-owned — into the service's credentials directory,
# owned by the service user and mode 0400; %d is that directory, so the
# process reads the copy and never the source. internal/secret accepts 0400
...
LoadCredential=admin-key:/etc/todo/admin-key
Environment=TODO_ADMIN_EMAIL=admin@example.com
Environment=TODO_ADMIN_KEY_FILE=%d/admin-key
```

`LoadCredential` copies the operator's key file into a private directory for the service, owned by the service user and readable by no one else. `%d` is that directory, so the app reads the copy and never `/etc/todo`. The copy is always 0400, so the app's own mode check cannot fail on this path. That check guards a run that points `TODO_ADMIN_KEY_FILE` straight at a file, as the drill below does: a key readable by group or other stops the boot, and the message names the mode.

The memory ceiling and the lifecycle:

<!-- verify: deploy/todo-server.service at=deploy -->
```ini title="deploy/todo-server.service"
MemoryMax=256M

# Lifecycle. SIGTERM is systemd's default kill signal and is named here
# because the binary's drain semantics depend on it: the first signal drains,
# bounded by the process's own budget, and a second one ends it outright.
# TimeoutStopSec must outlast everything the process does on the way out or
# systemd's SIGKILL would cut it: the drain (15s), the tracer's flush (5s,
# after the drain), and a margin — 25s. Restart brings the service back after
# a crash or an OOM kill; a clean stop is exit 0 and is not restarted.
Restart=on-failure
RestartSec=5s
KillSignal=SIGTERM
TimeoutStopSec=25s
```

`MemoryMax=256M` is a ceiling, not a target — the server's working set is well under it, and the limit is what catches a runaway. The lifecycle's numbers line up with the code we just read: the drain's fifteen seconds, the tracer's five, and a margin, all inside `TimeoutStopSec=25s`. A clean stop is exit 0 and stays stopped; a crash comes back.

Then the sandbox — the part that limits what the process can see and do:

<!-- verify: deploy/todo-server.service at=deploy -->
```ini title="deploy/todo-server.service"
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectClock=yes
ProtectControlGroups=yes
ProtectHostname=yes
ProtectKernelLogs=yes
ProtectKernelModules=yes
ProtectKernelTunables=yes
ProtectProc=invisible
ProcSubset=pid
RestrictAddressFamilies=AF_INET AF_INET6
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
UMask=0077
```

Each line removes a door the process does not use: no extra privileges, no capabilities, no home, no shared temporary files, no devices, no kernel settings, no executable memory. It is a network service, so the two internet address families stay open; everything else is closed. `UMask=0077` makes every file the process creates owner-only — the same rule the credential follows.

The file's last two lines are what let `systemctl enable` start it at boot:

<!-- verify: deploy/todo-server.service at=deploy -->
```ini title="deploy/todo-server.service"
[Install]
WantedBy=multi-user.target
```

That completes the unit: the program, its world, its credential, its budgets, and how it starts at boot.

## The proxy in front

The proxy we use is Caddy, and its whole configuration is one site block:

<!-- verify: deploy/Caddyfile at=deploy -->
```text title="deploy/Caddyfile"
todo.example.com {
	@internals path /metrics
	respond @internals 404

	reverse_proxy 127.0.0.1:8080
}
```

Replace `todo.example.com` with the name that resolves to your server. Caddy fetches and renews the certificate itself — the ACME protocol, over ports 80 and 443 — so nothing here names a certificate file. Every request is handed to the server's loopback address. The one thing the proxy closes is `/metrics`: the traffic counters are not the public site's business, so a scraper on the machine itself still reaches the server directly, and a remote one needs a deliberate exception in this file.

A proxy changes what the server sees: every request arrives from the proxy, not from the client. That matters to the login limiter, which counts attempts per address — with the proxy in front, the whole internet would share one bucket. So the server learns one new trick: when, and only when, the request came from the loopback proxy, it believes the `X-Forwarded-For` header the proxy writes. That header is a note a proxy adds saying where the request came from.

<!-- verify: internal/api/api.go at=deploy -->
```go title="internal/api/api.go"
	e.IPExtractor = echo.ExtractIPFromXFFHeader(
		echo.TrustLoopback(true),
		echo.TrustLinkLocal(false),
		echo.TrustPrivateNet(false),
	)
```

Read the three options: trust loopback, trust nothing else. From any other peer, a forwarded address moves nothing. The extractor walks the header from the right, because the last address in it is the one the proxy added — a client's own fake prefix sits to the left and is never read.

<!-- verify: internal/api/ratelimit.go at=deploy -->
```go title="internal/api/ratelimit.go"
func peerAddress(c echo.Context) (string, error) {
	if ip := c.RealIP(); ip != "" {
		return ip, nil
	}
	return c.Request().RemoteAddr, nil
}
```

The limiter now asks the extractor for the client's address and falls back to the socket when there is none. The trust case from the top of the lesson passes, and the cases beside it keep the door from widening: `X-Real-IP` is still never consulted, and a private-network peer's forwarded address still moves nothing.

```bash
--- PASS: TestLoginLimiter_OtherRoutesUnaffected (0.15s)
--- PASS: TestLoginLimiter_429 (0.30s)
--- PASS: TestLoginLimiter_RealIPHeaderIgnored (0.31s)
--- PASS: TestLoginLimiter_PrivatePeerUntrusted (0.32s)
--- PASS: TestLoginLimiter_KeyedOnPeerAddress (0.33s)
--- PASS: TestLoginLimiter_TrustedProxy (0.34s)
ok  	todo/internal/api	0.386s
```

You can check the proxy's file without installing Caddy. This command fetches Caddy just for the check, outside the project, so nothing is added to `go.mod`:

```bash
$ go run github.com/caddyserver/caddy/v2/cmd/caddy@v2.11.7 validate --config deploy/Caddyfile
{"logger":"http.auto_https","msg":"server is listening only on the HTTPS port but has no TLS connection policies; adding one to enable TLS",…}
{"logger":"http.auto_https","msg":"enabling automatic HTTP->HTTPS redirects",…}
Valid configuration
```

The two `auto_https` lines are Caddy telling you what it will do: fetch a certificate, and send plain-http visitors to the https site. `Valid configuration` is the part you want.

## The backup job

The database is one file with companions — the engine calls them sidecars. Recent writes live in a log beside the main file until the engine folds them in, and between folds the log is where the newest rows are. A copy of the main file alone opens perfectly well and holds nothing. So the job is a file copy, and the order is the decision:

<!-- verify: deploy/todo-backup.sh at=deploy -->
```text title="deploy/todo-backup.sh"
# Order: the main file first, then every sidecar. The main file only advances
# at a checkpoint; the log only grows between checkpoints. A copy taken
# db-first is therefore either current (log appended since) or consistent but
# a checkpoint old (log truncated under it) — never a log applied to the
# wrong database. Sidecars-first would risk exactly that: a log read before a
# checkpoint, then a main file read after it, restores a stale delta onto a
# newer file.
```

Main file first, sidecars after. A copy taken in this order is either current or one fold old — and never an old log applied to a newer file, which is what the other order could produce.

The body is four settings with defaults, the copy, and a check:

<!-- verify: deploy/todo-backup.sh at=deploy -->
```text title="deploy/todo-backup.sh"
set -eu

DB=${TODO_DB:-/var/lib/todo/todo.db}
DIR=${TODO_BACKUP_DIR:-/var/lib/todo/backups}
BIN=${TODO_BIN:-/usr/local/bin/todo}
KEEP=${TODO_BACKUP_KEEP:-14}

umask 077
mkdir -p "$DIR"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
dest=$DIR/todo-$stamp.db

if [ ! -f "$DB" ]; then
	echo "todo-backup: $DB does not exist" >&2
	exit 1
fi

cp -- "$DB" "$dest"
if [ -e "$DB-log" ]; then cp -- "$DB-log" "$dest-log"; fi
if [ -e "$DB-wal" ]; then cp -- "$DB-wal" "$dest-wal"; fi
if [ -e "$DB-shm" ]; then cp -- "$DB-shm" "$dest-shm"; fi
```

`set -eu` stops the script at the first failure, and the four settings at the top have defaults the unit overrides. `umask 077` makes every file the script writes owner-only, like the credential. The timestamp names each copy, and the four `cp` lines are the copy itself — main file first.

<!-- verify: deploy/todo-backup.sh at=deploy -->
```text title="deploy/todo-backup.sh"
# The verification must not write a second log file beside the backups:
# TODO_LOG is set to /dev/null, the CLI's log sink is resolved on every run,
# and the copy's own records are the backup's business, not the CLI's.
if ! TODO_LOG=/dev/null "$BIN" --db "$dest" list --json >/dev/null; then
	echo "todo-backup: $dest failed verification; discarding" >&2
	rm -f "$dest" "$dest-log" "$dest-wal" "$dest-shm"
	exit 1
fi

echo "todo-backup: wrote $dest"

# Keep the newest $KEEP copies. The sidecars are removed too in case a copy
# never reached the verification's fold.
ls -1t "$DIR"/todo-*.db 2>/dev/null | tail -n +"$((KEEP + 1))" | while IFS= read -r old; do
	rm -f "$old" "$old-log" "$old-wal" "$old-shm"
done
```

The check opens the copy with the CLI — the same program the deployment installs — and a copy that fails it is deleted, so the folder never keeps a file nobody trusts. Opening the copy folds its log in, which is why the finished copy is bigger than the files it was made from. Then the sweep deletes all but the newest fourteen.

The job's unit runs it as root, because it must read the server's data directory — and that directory belongs to an identity that changes every boot:

<!-- verify: deploy/todo-backup.service at=deploy -->
```ini title="deploy/todo-backup.service"
[Unit]
Description=Back up the todo database
Documentation=file:/usr/local/share/doc/todo/RUNBOOK.md

[Service]
Type=oneshot
ExecStart=/usr/local/lib/todo/todo-backup
Environment=TODO_DB=/var/lib/todo/todo.db
Environment=TODO_BACKUP_DIR=/var/lib/todo/backups
Environment=TODO_BIN=/usr/local/bin/todo
MemoryMax=256M
ProtectSystem=strict
ReadWritePaths=/var/lib/todo
PrivateTmp=yes
NoNewPrivileges=yes
CapabilityBoundingSet=
```

`Type=oneshot` and no `Restart`: a failed run stays failed, because the next day's run is the retry, and a loop that hides a failure would be worse. `ReadWritePaths` is the one directory the job may write, out of an otherwise read-only filesystem.

The timer is four settings and one line that matters most:

<!-- verify: deploy/todo-backup.timer at=deploy -->
```ini title="deploy/todo-backup.timer"
[Timer]
OnCalendar=daily
RandomizedDelaySec=30m
AccuracySec=1m
Persistent=true

[Install]
WantedBy=timers.target
```

`Persistent=true` is the important one: a machine that was off at midnight runs the missed backup at the next boot instead of skipping it. The randomized delay spreads the wakeup so many machines do not hit their disks at once. From then on, the copies happen without anyone watching.

A run prints one line, and the folder shows what the check left behind:

```bash
---- the backup job, with the unit's environment ----
todo-backup: wrote …/backups/todo-20261015T114429Z.db
exit: 0

---- the backup directory ----
-rw-------. 1 pm pm 69632 todo-20261015T114429Z.db
-rw-------. 1 pm pm     0 todo-20261015T114429Z.db-log
-rw-------. 1 pm pm     0 todo-20261015T114429Z.db-wal
```

The copy is 68 KiB because the check's open folded the log in, and the sidecars beside it are empty. For contrast, the trap — a copy of the main file alone, opened by the same CLI:

```bash
---- the trap: a copy of the .db file alone ----
todo list on the .db alone: exit 0, 0 tasks
```

Exit 0, zero tasks. The migrations rebuild an empty schema, the list is empty, and nothing complains. That is why the job copies the sidecars at all.

## The runbook: putting it on the server

The runbook is the file that records the whole procedure, so the next person — or your future self at an awkward hour — can follow it. It opens with the shape of the deployment:

<!-- verify: deploy/RUNBOOK.md at=deploy -->
```text title="deploy/RUNBOOK.md"
One binary, one systemd unit, one Caddy site, one backup timer. The shape:
...
client ──TLS──> Caddy :443 ──http──> 127.0.0.1:8080 (todo-server) ──> /var/lib/todo/todo.db
                     │                        (DynamicUser, StateDirectory, LoadCredential)
                     └── ACME (ports 80/443)          ▲
                                                      │
                              /usr/local/lib/todo/todo-backup ── todo-backup.timer (daily)
```

The picture is the whole lesson: a client reaches Caddy over TLS, Caddy reaches the server on loopback, the server owns the database in `/var/lib/todo`, and the backup job touches the same directory on a timer.

The install starts with the two programs:

<!-- verify: deploy/RUNBOOK.md at=deploy -->
```text title="deploy/RUNBOOK.md"
   CGO_ENABLED=0 go build -trimpath -o todo-server ./cmd/todo-server
   CGO_ENABLED=0 go build -trimpath -o todo      ./cmd/todo
   sudo install -m 0755 todo-server todo /usr/local/bin/
```

`CGO_ENABLED=0` asks for programs built without a C toolchain — nothing extra to install on the machine that builds them — and `-trimpath` keeps your folder names out of them. The database engine still calls into the system's C library while it runs, which every Linux server already carries. Copy both to `/usr/local/bin`; the CLI is not decoration, because the backup job checks its copies with it.

Then the files themselves:

<!-- verify: deploy/RUNBOOK.md at=deploy -->
```text title="deploy/RUNBOOK.md"
   sudo install -m 0644 deploy/todo-server.service \
       deploy/todo-backup.service deploy/todo-backup.timer /etc/systemd/system/
   sudo install -D -m 0755 deploy/todo-backup.sh /usr/local/lib/todo/todo-backup
   sudo install -D -m 0644 deploy/RUNBOOK.md /usr/local/share/doc/todo/RUNBOOK.md
   sudo systemctl daemon-reload
```

This copies the three unit files where systemd looks for them, puts the backup script where its unit expects it, and tells systemd to re-read its files. The proxy is next:

<!-- verify: deploy/RUNBOOK.md at=deploy -->
```text title="deploy/RUNBOOK.md"
   sudo install -m 0644 deploy/Caddyfile /etc/caddy/Caddyfile
   sudoedit /etc/caddy/Caddyfile        # replace todo.example.com with your name
   sudo systemctl reload caddy
```

Install Caddy for your distribution first, then this copies the site file and reloads the proxy.

The admin credential is generated once and kept owner-only:

<!-- verify: deploy/RUNBOOK.md at=deploy -->
```text title="deploy/RUNBOOK.md"
   openssl rand -base64 24          # store this value, then:
   sudo install -d -m 0750 /etc/todo
   printf '%s\n' '<the value>' | sudo tee /etc/todo/admin-key >/dev/null
   sudo chown root:root /etc/todo/admin-key
   sudo chmod 0400 /etc/todo/admin-key
```

`openssl rand -base64 24` prints a random key; keep a copy in your password manager. The rest writes it to `/etc/todo/admin-key`, owned by root and readable by no one else — the mode the app checks whenever it reads the file directly, as the drill below does.

Then start it, and look through the front door:

<!-- verify: deploy/RUNBOOK.md at=deploy -->
```text title="deploy/RUNBOOK.md"
   sudo systemctl enable --now todo-server
   systemctl status todo-server --no-pager
   journalctl -u todo-server -n 20 --no-pager
...
   curl -fsS https://todo.example.com/healthz      # {"status":"ok"}
   curl -fsS https://todo.example.com/ready        # pings the database
```

The first boot logs `admin credential ensured` with `created:true` — the key became the admin account — then `server listening`. The two curls answer `{"status":"ok"}` and the database's own check, and you can log in at the site with the admin email and the key.

Once a quarter, serve the newest copy on a scratch port and look at it:

<!-- verify: deploy/RUNBOOK.md at=deploy -->
```text title="deploy/RUNBOOK.md"
sudo systemctl stop todo-server
sudo install -m 0600 -o root -g root \
    /var/lib/todo/backups/todo-<stamp>.db /var/lib/todo/restore-drill.db
sudo env TODO_DB=/var/lib/todo/restore-drill.db TODO_LOG=/dev/null \
    TODO_ADMIN_EMAIL=you@example.com TODO_ADMIN_KEY_FILE=/etc/todo/admin-key \
    /usr/local/bin/todo-server --listen 127.0.0.1:8081
# in another shell: log in at http://127.0.0.1:8081/login with the key and
# compare the task list with what you expect. Then Ctrl-C — the first signal
# drains — and:
sudo rm /var/lib/todo/restore-drill.db
sudo systemctl start todo-server
```

That is the drill: stop the server, put the copy aside, start a second server on a different port with the same key, log in, and compare the task list with what you expect. Then delete the scratch copy and start the real server again. A drill against a copy that held three tasks reads back all three, and the scratch server exits cleanly on the first signal:

```bash
---- the restore drill: the copy served on a scratch port ----
the copy serves 3 tasks: ['buy milk', 'walk the dog', 'water the plants']
the drill server's exit: 0
```

An upgrade is the new binary, then a restart:

<!-- verify: deploy/RUNBOOK.md at=deploy -->
```text title="deploy/RUNBOOK.md"
sudo cp /usr/local/bin/todo-server /usr/local/bin/todo-server.prev
# build, then:
sudo install -m 0755 todo-server /usr/local/bin/todo-server
sudo systemctl restart todo-server
journalctl -u todo-server -n 10 --no-pager    # "shutting down" → "server stopped"
curl -fsS http://127.0.0.1:8080/ready
```

The restart sends SIGTERM: the old process drains its in-flight requests, exits 0, and the new binary takes over. That is the routine every future change follows — build, copy, restart — with the previous binary kept for the day a change needs undoing.

## If something went wrong

**`todo-server.service: Command /usr/local/bin/todo-server is not executable: No such file or directory`.** You checked the unit — with `systemd-analyze verify deploy/todo-server.service` — before the program was in place:

```bash
todo-server.service: Command /usr/local/bin/todo-server is not executable: No such file or directory
exit: 1
```

The unit names the installed path, so the check wants the binary there. Build and install first, then check.

**`"5s" is not greater than or equal to "10s"` — the drain below the request deadline.** The first failure above: the budget is still the old five seconds. A drain below the deadline cuts requests the server would still have served, and the cut exits non-zero. The fix is the fifteen-second constant from "Stopping without dropping a request".

**`a second SIGTERM did not end the drain` — the handler is still installed.** The second failure above. The first signal canceled the context, but the program still listens for signals, so the second one lands in a queue and is swallowed; the process waits out the whole budget. The fix is `stop()` at the first signal, exactly as in the quote.

**`expected: 401 / actual: 429` — the limiter keyed on the proxy's socket.** The trust case before the extractor exists:

```bash
--- FAIL: TestLoginLimiter_TrustedProxy (0.15s)
    security_test.go:334:
        	Error:      	Not equal:
        	            	expected: 401
        	            	actual  : 429
```

With Caddy on loopback, every request's socket is the proxy, so one bucket served the whole internet — the old rule working exactly as designed. The fix is the extractor in `New`, with loopback as the only trusted peer.

**`exit status 127 … No such file or directory` — the backup script does not exist yet.** The last failure above: the test runs `deploy/todo-backup.sh`, and the shell cannot find it. Check the file's name and folder; the test looks for it at exactly `deploy/todo-backup.sh`.

**`File is locked by another process` — the database is held open.** A second program opening the live database while the server runs:

```bash
open turso store live/todo.db: enable mvcc: turso: error: Locking error: Failed locking file 'live/todo.db'. File is locked by another process
exit: 1
```

The database file is locked for as long as the server holds it. Stop the server first, or read a backup copy instead — which is the whole reason the backup job exists.

<details>
<summary>Going deeper: what the sandbox lines take away</summary>

Every line in the unit's sandbox section removes a door the process does not need. The groups are worth naming: `DynamicUser` plus `ProtectSystem=strict`, `ProtectHome=yes`, and the two state directories are the filesystem story — a throwaway identity with exactly two writable folders and a read-only everything else. `ProtectProc=invisible` and `ProcSubset=pid` hide other programs' processes, and `PrivateDevices`, `ProtectClock`, and the `ProtectKernel*` lines cut the process off from devices and kernel settings.

`MemoryDenyWriteExecute` and `SystemCallFilter=@system-service` are the execution story: the process may not turn data into runnable code, and it may make only the system calls a service normally needs. `UMask=0077` is the credential rule arriving by default.

systemd can score the result. Lower is tighter, and this unit scores well:

```bash
✗ SystemCallFilter=~@resources     System call allow list … @resources is included (e.g. ioprio_set is allowed)   0.2
✗ SystemCallFilter=~@privileged    System call allow list … @privileged is included (e.g. chown is allowed)       0.2
✗ RootDirectory=/RootImage=        Service runs within the host's root directory                                  0.1
✗ RestrictAddressFamilies=~AF_(INET|INET6)   Service may allocate Internet sockets                               0.3
✗ PrivateNetwork=                  Service has access to the host's network                                     0.5
✗ PrivateUsers=                    Service has access to other users                                          0.2
✗ DeviceAllow=                     Service has a device ACL with some special devices: char-rtc:r             0.1
✗ IPAddressDeny=                   Service does not define an IP address allow list                           0.2
→ Overall exposure level for todo-server.service: 1.5 OK 🙂
```

The remaining items are mostly the service's job: it is a network service, so it needs the network, and the system-call list is the broadest allowlist that still means something. If the process ever grows a new need — a unix socket would need `AF_UNIX` — the runbook's day-two section names the doors to revisit.

</details>

<details>
<summary>Going deeper: why the copy takes the main file first</summary>

The engine folds the log into the main file when it gets the chance — at a stop, and now and then during a long run. Between folds, the log is where the newest rows live, and the main file is a snapshot that is one or more folds old. The copy order pairs the two reads so the pairing can only fail in the harmless direction.

A copy taken main-file-first is either current — the log was read after a fold appended to it — or consistent but one fold old — the log was folded and emptied under the copy. Never a stale log applied to a newer file. The other order can produce exactly that: the log read just before a fold, the main file read just after it, and a restore that pairs a fresh main file with a log that describes an older one. Rows written between the two reads would vanish, and the copy would still open. That is why the order is written down in the script's header, not left to taste.

</details>

<details>
<summary>Going deeper: what the backup check can and cannot prove</summary>

The check proves three things: the copy opens, it is not torn — every page is readable — and its schema is current. That is worth having on every run, and it is not everything.

It cannot prove the copy is *current*. The live database is locked by the server, so nothing can compare the two; the check would have to open the original, and it cannot. It also does not read the rows: the CLI's list has no user attached, so an empty database passes the same check — the `.db`-alone trap is the proof, and it exits 0 with zero tasks. The rows are the drill's job, because the drill logs in and looks at them. That is why the lesson keeps both: the automatic check on every run, and the quarterly drill that reads a real task list back.

</details>

The app runs on a machine that is not ours now — watched, proxied, and backed up — and next it gets a version of its own to install.
