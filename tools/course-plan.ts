#!/usr/bin/env bun
/**
 * The course plan — every part, lesson, and review day.
 *
 * The generator reads this file; `status` decides whether a planned day is
 * generated yet. New production-ground lessons enter as `planned`, then flip
 * to `written` as their chapter source and transcript capture land.
 */
export type Chapter = {
	n: number;
	title: string;
	slug: string;
	hours: number;
	bullets: string[];
	split?: string;
	/** A planned chapter is listed in the index but has no page yet. */
	status?: 'written' | 'planned';
	/** The app revision `bun run verify` quotes for this lesson. */
	tag?: string;
};

export type Part = {
	roman: string;
	name: string;
	/** The reader-facing stretch this part belongs to. */
	section: string;
	chapters: Chapter[];
	review: string;
	/** Production reviews replace the generic checklist with real drills. */
	reviewItems?: string[];
	production?: boolean;
};

export const parts: Part[] = [
	{
		roman: 'I',
		name: 'Getting started',
		section: 'Days 1–60 — The app',
		chapters: [
			{ n: 1, title: 'The first test', slug: '/part-i/01-toolchain-first-test/', hours: 1.5, bullets: ['have the `todo` module and a test that passes — written before the code it tests;', 'know the loop every chapter runs: write the test, watch it fail, make it pass.'] },
			{ n: 2, title: 'Structs and methods', slug: '/part-i/02-structs-and-methods/', hours: 2.5, bullets: ['give a task a status, a priority, and an optional due date — with a constructor that refuses a blank title;', 'teach a type to describe itself in one line with `String()`.'] },
			{ n: 3, title: 'A list of tasks', slug: '/part-i/03-slices-and-maps/', hours: 3, bullets: ['keep tasks in an in-memory store that adds, lists, filters, counts, and sorts;', 'read and write slices and maps, and hide a store’s internals behind methods.'] },
			{ n: 4, title: 'When things go wrong', slug: '/part-i/04-errors-as-values/', hours: 2.5, bullets: ['return errors as values, wrap them with context, and match them by identity with `errors.Is` and `errors.As`;', 'explain why error text is not an API.'] },
		],
		review: 'run `go test -v ./...` and read the names of the tests you wrote this week — each one is a claim you decided.',
	},
	{
		roman: 'II',
		name: 'Structuring the code',
		section: 'Days 1–60 — The app',
		chapters: [
			{ n: 5, title: 'Interfaces and fakes', slug: '/part-ii/05-interfaces-and-fakes/', hours: 2.5, bullets: ['describe what the store must do with an interface, and write a fake that fails on command;', 'recognize interface satisfaction and the embedding trick.'] },
			{ n: 6, title: 'Organizing the code', slug: '/part-ii/06-packages-and-layout/', hours: 2.5, bullets: ['move the packages under `internal/` and write the first runnable command;', 'explain why `internal/` keeps code private.'] },
			{ n: 7, title: 'Generics', slug: '/part-ii/07-generics-and-stdlib/', hours: 2.5, bullets: ['write a function that works for many types with a type parameter;', 'reach for the standard library’s `slices` and `maps` helpers first.'] },
			{ n: 8, title: 'Custom types', slug: '/part-ii/08-custom-types-encodings/', hours: 2.5, bullets: ['define custom types that know how to render and parse themselves;', 'round-trip them through text and pin the encodings with table tests.'] },
		],
		review: 'open [the finished app’s appendix]({{BASE}}/appendices/the-finished-app/) and find the `Store` interface — see how small it stayed.',
	},
	{
		roman: 'III',
		name: 'Testing',
		section: 'Days 1–60 — The app',
		chapters: [
			{ n: 9, title: 'Table-driven tests', slug: '/part-iii/09-table-tests-testify/', hours: 3, bullets: ['turn every test into a table with named subtests, using testify;', 'run cases in parallel safely.'] },
			{ n: 10, title: 'Snapshot tests', slug: '/part-iii/10-golden-snapshots/', hours: 2.5, bullets: ['record golden snapshots and read the diff when the output changes;', 'explain why a snapshot is only as good as its last review.'] },
			{ n: 11, title: 'Coverage, races, and fuzzing', slug: '/part-iii/11-coverage-race-fuzz/', hours: 3, bullets: ['measure coverage and read the report for what it hides;', 'run the race detector and write a fuzz target that keeps its corpus.'] },
			{ n: 12, title: 'Benchmarks', slug: '/part-iii/12-benchmarks-benchstat/', hours: 3, bullets: ['write benchmarks and compare two candidates with benchstat;', 'read the numbers honestly — what `allocs/op` guarantees and `B/op` doesn’t.'] },
			{ n: 13, title: 'Linters and code generation', slug: '/part-iii/13-vet-lint-codegen/', hours: 3, bullets: ['run vet and gofmt, and put golangci-lint behind a config;', 'generate a mock with a `//go:generate` directive, and keep the Makefile’s named commands.'] },
		],
		review: 'run `go test -count=1 -cover ./...` and see the numbers your work put there.',
	},
	{
		roman: 'IV',
		name: 'Concurrency',
		section: 'Days 1–60 — The app',
		chapters: [
			{ n: 14, title: 'Goroutines and channels', slug: '/part-iv/14-goroutines-channels/', hours: 3, bullets: ['run work in goroutines and pass results over channels;', 'wait for a group, and recognize the races the detector finds.'] },
			{ n: 15, title: 'select and timeouts', slug: '/part-iv/15-select-timeouts/', hours: 2.5, bullets: ['wait on several channels at once with `select`, and put timeouts on the waits;', 'build a worker pool that can stop early.'] },
			{ n: 16, title: 'Context and cancellation', slug: '/part-iv/16-context/', hours: 3, bullets: ['thread `context` through the store so callers can cancel work;', 'delete the hand-rolled cancel plumbing in favor of `ctx`.'] },
			{ n: 17, title: 'Mutexes and atomics', slug: '/part-iv/17-sync-atomics/', hours: 3, bullets: ['guard shared state with a read-write lock and count with atomics;', 'explain what a lock’s happens-before promise buys.'] },
			{ n: 18, title: 'Running work in parallel', slug: '/part-iv/18-errgroup-parallelism/', hours: 3, bullets: ['bound parallelism with errgroup: a fixed crew, fail-fast, siblings cancelled;', 'measure whether the parallel version is actually faster.'] },
		],
		review: 'run the race detector over the store tests once more — and watch it stay quiet.',
	},
	{
		roman: 'V',
		name: 'The data layer',
		section: 'Days 1–60 — The app',
		chapters: [
			{ n: 19, title: 'Export and import', slug: '/part-v/19-export-import/', hours: 3, bullets: ['define a versioned JSON document and export and import the store through it;', 'write files atomically and refuse documents the app didn’t write.'] },
			{ n: 20, title: 'Adding a database', slug: '/part-v/20-turso/', hours: 4, bullets: ['open a real database — Turso, with no C compiler in sight;', 'run one conformance suite against both the memory and database stores.'], split: 'stop after “Watch it fail” passes, and pick up at “The schema and the handle” tomorrow.' },
			{ n: 21, title: 'Database migrations', slug: '/part-v/21-migrations-goose/', hours: 3, bullets: ['write SQL migrations, embed them in the binary, and apply them at boot;', 'keep a golden schema that fails when the shape drifts.'] },
			{ n: 22, title: 'Queries with sqlc', slug: '/part-v/22-sqlc-queries/', hours: 3, bullets: ['write the queries in SQL and generate typed Go from them with sqlc;', 'keep generated code out of hand edits.'] },
			{ n: 23, title: 'IDs and time', slug: '/part-v/23-ids-and-time/', hours: 3, bullets: ['move to UUIDv7 ids and keep times in UTC;', 'migrate existing rows safely and version the export format.'] },
			{ n: 24, title: 'Transactions', slug: '/part-v/24-transactions/', hours: 4, bullets: ['make multi-step writes all-or-nothing with transactions;', 'add optimistic concurrency — a version column, compare-and-swap, retries — and keep the importer atomic.'], split: 'stop after “The compare-and-swap” passes, and pick up at “Every write rides a transaction” tomorrow.' },
		],
		review: 'open the appendix’s `schema.sql` beside the migrations you wrote — you can read the database’s shape now.',
	},
	{
		roman: 'VI',
		name: 'The command-line app',
		section: 'Days 1–60 — The app',
		chapters: [
			{ n: 25, title: 'A command-line tool', slug: '/part-vi/25-cobra-commands/', hours: 3, bullets: ['build a command tree with cobra: add, list, done, and friends;', 'test the commands and read the help they print.'] },
			{ n: 26, title: 'Configuration', slug: '/part-vi/26-config-paths/', hours: 3, bullets: ['resolve settings from flag → environment → sensible defaults;', 'test the whole ladder as a table.'] },
			{ n: 27, title: 'Output formats', slug: '/part-vi/27-output-formats/', hours: 3, bullets: ['print both a human table and machine JSON;', 'keep the JSON shape stable and record it as a snapshot.'] },
			{ n: 28, title: 'Integration tests', slug: '/part-vi/28-cli-integration/', hours: 3, bullets: ['black-box test the real binary with testscript;', 'keep scenarios in txtar files and measure the binary’s coverage.'] },
			{ n: 29, title: 'Logging', slug: '/part-vi/29-logging-slog/', hours: 3, bullets: ['log structured records with slog, with levels and a flag;', 'write JSON to a file while humans get readable lines.'] },
		],
		review: 'run `./todo --help`, then `./todo list --json` — the tool answers like a real program.',
	},
	{
		roman: 'VII',
		name: 'The HTTP API',
		section: 'Days 1–60 — The app',
		chapters: [
			{ n: 30, title: 'The first API endpoint', slug: '/part-vii/30-echo-first-handler/', hours: 3, bullets: ['serve the first HTTP endpoints with echo: liveness and readiness;', 'shut the server down gracefully, and test it black-box.'] },
			{ n: 31, title: 'Tasks over HTTP', slug: '/part-vii/31-crud-validation/', hours: 3, bullets: ['build the task CRUD endpoints, with validation that answers 422;', 'keep every failure in one error shape.'] },
			{ n: 32, title: 'Middleware', slug: '/part-vii/32-middleware-stack/', hours: 3, bullets: ['assemble the middleware stack: request ids, logging, recovery, security headers;', 'handle errors in one place.'] },
			{ n: 33, title: 'Users and sessions', slug: '/part-vii/33-auth-sessions/', hours: 3, bullets: ['register, log in, and log out users;', 'hash passwords with argon2id and carry identity in a cookie session that rotates on login.'] },
			{ n: 34, title: 'Authorization', slug: '/part-vii/34-authorization/', hours: 3, bullets: ['scope every task to its owner;', 'grant an admin, and leave an audit trail of who did what.'] },
			{ n: 35, title: 'API documentation', slug: '/part-vii/35-openapi-swagger/', hours: 3, bullets: ['annotate the API and generate an OpenAPI spec;', 'serve Swagger UI and keep the docs under test.'] },
		],
		review: 'open `/swagger/index.html` and click through the endpoints you built.',
	},
	{
		roman: 'VIII',
		name: 'The web UI',
		section: 'Days 1–60 — The app',
		chapters: [
			{ n: 36, title: 'The first web page', slug: '/part-viii/36-templ-basics/', hours: 3, bullets: ['render the first server-side page with templ components;', 'lay out a page, and let escaping keep it safe.'] },
			{ n: 37, title: 'Forms', slug: '/part-viii/37-forms-csrf/', hours: 3, bullets: ['build the login and task forms with CSRF protection;', 'use submit-then-redirect so refreshes don’t repeat actions.'] },
			{ n: 38, title: 'CSS and static files', slug: '/part-viii/38-assets-embed/', hours: 3, bullets: ['style the pages with a small design system;', 'embed the assets in the binary and serve them with cache validation.'] },
			{ n: 39, title: 'Web security', slug: '/part-viii/39-web-security/', hours: 3, bullets: ['harden the web app: CSP, HSTS, cookie rules, and a login limiter;', 'explain each header in one sentence.'] },
			{ n: 40, title: 'Testing the pages', slug: '/part-viii/40-web-snapshot-tests/', hours: 3, bullets: ['snapshot-test whole pages;', 'prove the flows through the real binary.'] },
		],
		review: 'view the source of the login page and find the CSRF token your own middleware put there.',
	},
	{
		roman: 'IX',
		name: 'The terminal UI',
		section: 'Days 1–60 — The app',
		chapters: [
			{ n: 41, title: 'A terminal interface', slug: '/part-ix/41-tui-basics/', hours: 3, bullets: ['run a full-screen terminal interface with Bubble Tea’s event loop;', 'drive it with keys and a model.'] },
			{ n: 42, title: 'Styling the terminal UI', slug: '/part-ix/42-tui-styling/', hours: 3, bullets: ['style the interface with lipgloss;', 'make a frame that fits the terminal it runs in.'] },
			{ n: 43, title: 'Talking to the API', slug: '/part-ix/43-tui-client/', hours: 3, bullets: ['give the interface an HTTP client that talks to the API;', 'handle the live conflict and sign in from the TUI.'] },
			{ n: 44, title: 'Testing the terminal UI', slug: '/part-ix/44-tui-tests-logging/', hours: 3, bullets: ['test the interface with teatest and golden frames;', 'read its debug log when a session goes wrong.'] },
		],
		review: 'resize the terminal while the interface runs — the frame follows.',
	},
	{
		roman: 'X',
		name: 'Shipping it',
		section: 'Days 1–60 — The app',
		chapters: [
			{ n: 45, title: 'Tracing and metrics', slug: '/part-x/45-observability/', hours: 3, bullets: ['trace requests and expose Prometheus metrics;', 'profile the server with pprof when the numbers look wrong.'] },
			{ n: 46, title: 'Secrets', slug: '/part-x/46-secrets/', hours: 3, bullets: ['load secrets from the environment or a mode-checked file;', 'rotate the admin key without leaving it in any log.'] },
			{ n: 47, title: 'The security audit', slug: '/part-x/47-security-audit/', hours: 3, bullets: ['write a threat model and keep the dependency list allowlisted;', 'run the vulnerability scan, the SBOM, and the lint floors as named commands.'] },
			{ n: 48, title: 'Deploying', slug: '/part-x/48-deploy/', hours: 3, bullets: ['deploy with a systemd unit and Caddy TLS;', 'back the database up on a timer and follow the runbook.'] },
			{ n: 49, title: 'Releases', slug: '/part-x/49-release/', hours: 3, bullets: ['stamp the version into the binary;', 'cut release archives and a container image with GoReleaser.'] },
			{ n: 50, title: 'Making it faster', slug: '/part-x/50-performance-tuning/', hours: 3, bullets: ['profile before changing anything;', 'make the list fast with an index and a merge join, and record the measurements that refused.'] },
		],
		review: 'read `deploy/RUNBOOK.md` in the appendix and try one drill — then take a break. You finished the course.',
	},
	{
		roman: 'XI',
		name: 'Containers and clusters',
		section: 'Days 61–90 — Production ground',
		production: true,
		chapters: [
			{ n: 51, title: 'The app in a box', slug: '/part-xi/51-docker-image/', hours: 3, status: 'written', tag: 'docker-runtime', bullets: ['build the server image from source and explain what each layer adds;', 'run it with a volume, read its logs, and prove `/ready` answers.'] },
			{ n: 52, title: 'Two containers, one command', slug: '/part-xi/52-compose/', hours: 3, status: 'written', tag: 'compose', bullets: ['describe the app and its proxy in one Compose file;', 'start, stop, and inspect the stack without remembering every flag.'] },
			{ n: 53, title: 'The first cluster', slug: '/part-xi/53-kubernetes-deployment/', hours: 3, status: 'written', tag: 'k8s-deploy', bullets: ['run the image as a Deployment and reach it through a Service;', 'read pods, events, and logs when the first rollout does not start.'] },
			{ n: 54, title: 'Config, probes, and limits', slug: '/part-xi/54-kubernetes-config/', hours: 3, status: 'written', tag: 'k8s-config', bullets: ['feed the app config and secrets without rebuilding the image;', 'make readiness and liveness probes tell the cluster the truth.'] },
			{ n: 55, title: 'Rolling forward', slug: '/part-xi/55-kubernetes-rollout/', hours: 3, status: 'written', tag: 'k8s-rollout', bullets: ['ship a new image without dropping a request;', 'roll back to the previous revision when the new one is wrong.'] },
		],
		reviewItems: [
			'Build the image from a clean tree and name it with the revision.',
			'Bring the stack up and check `/ready` through the proxy.',
			'Apply the manifests and watch `kubectl rollout status` finish.',
			'Roll back to the previous revision and confirm the old pods serve.',
		],
		review: 'A container stack is only finished when you can build it, run it, watch it, and put it back. If any of those still needs a hand-written note, write the note down.',
	},
	{
		roman: 'XII',
		name: 'Cloud and delivery',
		section: 'Days 61–90 — Production ground',
		production: true,
		chapters: [
			{ n: 56, title: 'Onto the cloud', slug: '/part-xii/56-aws-compute/', hours: 3, status: 'written', tag: 'aws-compute', bullets: ['run the container on a managed AWS service;', 'compare the cloud shape with the single box from the deployment days.'] },
			{ n: 57, title: 'Storage that outlives the machine', slug: '/part-xii/57-aws-storage/', hours: 3, status: 'written', tag: 'aws-storage', bullets: ['write backups to S3 with a role, not a password;', 'restore one into a scratch database and read a task back.'] },
			{ n: 58, title: 'Keys and permissions', slug: '/part-xii/58-aws-secrets/', hours: 3, status: 'written', tag: 'aws-secrets', bullets: ['move the admin key into a managed secret store;', 'give the service the narrowest role that still works.'] },
			{ n: 59, title: 'Checks on every change', slug: '/part-xii/59-ci-checks/', hours: 3, status: 'written', tag: 'ci-checks', bullets: ['run the same suite, build, and container check on every push;', 'read a failed job and fix the first real failure.'] },
			{ n: 60, title: 'Deploy on every change', slug: '/part-xii/60-cd-deploy/', hours: 3, status: 'written', tag: 'cd-deploy', bullets: ['deploy the artifact the checks passed;', 'smoke-test the new revision and roll back when it fails.'] },
		],
		reviewItems: [
			'Run the checks on a clean checkout, including the container build.',
			'Deploy the current revision to the cloud and smoke-test `/ready`.',
			'Restore a backup from S3 into a scratch database and read one task.',
			'Rotate the admin key through the secret store without a rebuild.',
		],
		review: 'The cloud is not a different app; it is the same app with different failure modes. The drill is to prove the runbook still works from a cold terminal.',
	},
	{
		roman: 'XIII',
		name: 'Data at scale',
		section: 'Days 61–90 — Production ground',
		production: true,
		chapters: [
			{ n: 61, title: 'The production database', slug: '/part-xiii/61-postgres-store/', hours: 3, status: 'written', tag: 'postgres-store', bullets: ['run the store conformance suite against PostgreSQL;', 'see what a full swap requires once the auth tables move too.'] },
			{ n: 62, title: 'Queries and indexes', slug: '/part-xiii/62-postgres-queries/', hours: 3, status: 'written', tag: 'postgres-queries', bullets: ['generate typed queries for PostgreSQL with sqlc;', 'read `EXPLAIN (ANALYZE, BUFFERS)` and add the index the plan asks for.'] },
			{ n: 63, title: 'Migrations and transactions', slug: '/part-xiii/63-postgres-migrations/', hours: 3, status: 'written', tag: 'postgres-migrations', bullets: ['migrate a live-shaped table in small, reversible steps;', 'choose an isolation level and retry the conflicts it produces.'] },
			{ n: 64, title: 'Load testing', slug: '/part-xiii/64-load-testing/', hours: 3, status: 'written', tag: 'load-test', bullets: ['drive the list and write paths with a real load tool;', 'record throughput, latency, and the knee where the curve bends.'] },
			{ n: 65, title: 'Tuning under load', slug: '/part-xiii/65-tuning/', hours: 3, status: 'written', tag: 'tuning', bullets: ['profile the server and the database under the same load;', 'keep only the changes the numbers support.'] },
		],
		reviewItems: [
			'Load the seeded database and run the load test; record the knee.',
			'Read `EXPLAIN (ANALYZE, BUFFERS)` for the slowest query and explain the plan.',
			'Run the migration from the previous schema and back it out.',
			'Restore the database and compare row counts.',
		],
		review: 'Numbers first, then the change. If the before and after cannot be printed side by side, the tuning is not finished.',
	},
	{
		roman: 'XIV',
		name: 'Services and streams',
		section: 'Days 61–90 — Production ground',
		production: true,
		chapters: [
			{ n: 66, title: 'Splitting the app', slug: '/part-xiv/66-microservices/', hours: 3, status: 'written', tag: 'microservices', bullets: ['find the seam where a read model can leave the monolith;', 'run the new service beside the API and route one feature to it.'] },
			{ n: 67, title: 'Typed calls', slug: '/part-xiv/67-grpc/', hours: 3, status: 'written', tag: 'grpc', bullets: ['define the service in a proto file and generate the Go stubs;', 'call it with a deadline and map its errors back to HTTP.'] },
			{ n: 68, title: 'Events on a log', slug: '/part-xiv/68-kafka-producer/', hours: 3, status: 'written', tag: 'kafka-producer', bullets: ['publish task changes to a Kafka topic with a stable key;', 'read the offsets and explain what order the topic guarantees.'] },
			{ n: 69, title: 'Consumers and replay', slug: '/part-xiv/69-kafka-consumer/', hours: 3, status: 'written', tag: 'kafka-consumer', bullets: ['consume the topic in a group and rebuild the read model;', 'reset the group and replay the log without duplicating rows.'] },
			{ n: 70, title: 'Caching and limits', slug: '/part-xiv/70-redis/', hours: 3, status: 'written', tag: 'redis', bullets: ['cache a hot read and invalidate it when an event arrives;', 'put a rate limit in Redis and test the boundary.'] },
			{ n: 71, title: 'Live updates', slug: '/part-xiv/71-websockets/', hours: 3, status: 'written', tag: 'websockets', bullets: ['push task changes to a connected browser over WebSockets;', 'handle reconnects and slow readers without losing the room.'] },
		],
		reviewItems: [
			'Start the service, the worker, Kafka, and Redis; publish one event.',
			'Watch the consumer index the event; reset the group and replay it.',
			'Call the gRPC endpoint through the API and check the deadline path.',
			'Open the WebSocket, change a task, and see the push arrive.',
		],
		review: 'A service boundary is real when the pieces can be started, stopped, and replayed independently. That is the test this review runs.',
	},
	{
		roman: 'XV',
		name: 'Reliability',
		section: 'Days 61–90 — Production ground',
		production: true,
		chapters: [
			{ n: 72, title: 'Retries, idempotency, ordering', slug: '/part-xv/72-distributed-systems/', hours: 3, status: 'written', tag: 'distributed', bullets: ['make every write safe to retry and every event safe to replay;', 'explain what “exactly once” really costs.'] },
			{ n: 73, title: 'Observability at scale', slug: '/part-xv/73-observability-scale/', hours: 3, status: 'written', tag: 'observability-scale', bullets: ['turn the metrics into dashboards and alerts that page only when they should;', 'follow one request across the API, the service, and the stream.'] },
			{ n: 74, title: 'Testing the system', slug: '/part-xv/74-testing-scale/', hours: 3, status: 'written', tag: 'testing-scale', bullets: ['write contract tests at the service boundaries;', 'run the load and failure suites against the split system.'] },
			{ n: 75, title: 'Security at scale', slug: '/part-xv/75-security-scale/', hours: 3, status: 'written', tag: 'security-scale', bullets: ['redraw the threat model with the new trust boundaries;', 'scan the supply chain and rotate a secret without downtime.'] },
		],
		reviewItems: [
			'Stop Kafka and Redis during a request; watch the API degrade.',
			'Fire the alert, read the dashboard, and follow the runbook.',
			'Run the contract and load suites against the split services.',
			'Rebuild the threat model with the new boundaries and rotate one secret.',
		],
		review: 'The final drill is the whole system: break one dependency, watch what notices, and put it back. Then take a break — you finished the production ground.',
	},
	{
		roman: 'XVI',
		name: 'Data structures and algorithms',
		section: 'Days 91–100 — Data structures and algorithms',
		chapters: [
			{ n: 76, title: 'Cost, measured', slug: '/part-xvi/76-cost-measured/', hours: 3, status: 'written', tag: 'dsa-growth', bullets: ['read Big-O as a shape, not a stopwatch;', 'measure two implementations with a benchmark and explain the gap.'] },
			{ n: 77, title: 'Slices and maps, underneath', slug: '/part-xvi/77-slices-maps/', hours: 3, status: 'written', tag: 'dsa-array', bullets: ['build a dynamic array and see the copy that pays for append;', 'compare a linear scan with a map lookup.'] },
			{ n: 78, title: 'Stacks, queues, and links', slug: '/part-xvi/78-stacks-queues/', hours: 3, status: 'written', tag: 'dsa-linear', bullets: ['choose a stack or a queue from the order the work needs;', 'see where a linked list earns its pointers and where a slice wins.'] },
			{ n: 79, title: 'Trees', slug: '/part-xvi/79-trees/', hours: 3, status: 'written', tag: 'dsa-trees', bullets: ['insert, search, and walk a binary search tree in order;', 'explain why an unbalanced tree loses its logarithmic promise.'] },
			{ n: 80, title: 'Heaps', slug: '/part-xvi/80-heaps/', hours: 3, status: 'written', tag: 'dsa-heaps', bullets: ['keep the smallest value at the root with two array walks;', 'use a heap to answer a top-k question without sorting everything.'] },
			{ n: 81, title: 'Graphs', slug: '/part-xvi/81-graphs/', hours: 3, status: 'written', tag: 'dsa-graphs', bullets: ['walk a graph breadth-first and depth-first;', 'find shortest paths with weights using Dijkstra.'] },
			{ n: 82, title: 'Sorting and searching', slug: '/part-xvi/82-sorting-searching/', hours: 3, status: 'written', tag: 'dsa-sorting', bullets: ['sort with quicksort and merge sort and compare their costs;', 'find a value in a sorted slice without scanning it.'] },
			{ n: 83, title: 'Practice, interview-shaped', slug: '/part-xvi/83-practice/', hours: 3, status: 'written', tag: 'dsa-practice', bullets: ['solve two-sum, balanced brackets, and top-k in Go;', 'explain the cost of each answer before writing it.'] },
			{ n: 84, title: 'Choosing the structure', slug: '/part-xvi/84-choosing/', hours: 3, status: 'written', tag: 'dsa-choose', bullets: ['build an LRU cache from a map and a list;', 'pick a structure from the operations the app actually runs.'] },
		],
		reviewItems: [
			'Run the whole DSA suite: `go test -race ./internal/dsa`.',
			'Run the growth benchmarks and compare the shapes, not the absolute times.',
			'Solve one unseen problem on paper, then in Go, and state its cost.',
			'Pick one app path and name the structure it already uses.',
		],
		review: 'The last ten days are a toolbox, not a trivia round. The win is choosing the right shape before the benchmark tells you.',
	},
];
