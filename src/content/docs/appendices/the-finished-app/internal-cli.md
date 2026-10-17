---
title: "internal/cli — the finished app"
description: "The finished app, file by file: internal/cli (spoilers)."
sidebar:
  hidden: true
tableOfContents: false
pagefind: false
---


Part of [The finished app (spoilers)](/100-days-of-go-lang/appendices/the-finished-app/).


## `internal/cli/__snapshots__/cli_test.snap`

````text

[TestStats_Snapshots/human - 1]
Total:   3
Done:    1
Pending: 2

---

[TestStats_Snapshots/json - 1]
{"total":3,"done":1,"pending":2}

---

[TestList_Snapshots/human_table - 1]
<id>  Todo  buy milk          2026-11-01  home
<id>  Todo  write the book
<id>  Done  ship it
<id>  Todo  water the plants              garden

---

[TestList_Snapshots/jsonl - 1]
{"id":"<id>","title":"buy milk","status":"Todo","priority":3,"due":"2026-11-01T00:00:00Z","tags":["home"],"version":1}
{"id":"<id>","title":"write the book","status":"Todo","priority":5,"due":null,"tags":[],"version":1}
{"id":"<id>","title":"ship it","status":"Done","priority":3,"due":null,"tags":[],"version":2}
{"id":"<id>","title":"water the plants","status":"Todo","priority":3,"due":null,"tags":["garden"],"version":1}

---
````


## `internal/cli/admin.go`

````go
package cli

import (
	"database/sql"
	"fmt"

	"github.com/spf13/cobra"

	"todo/internal/auth"
)

// The admin command group: the local operator's surface over users. The
// commands run against the database every other command opened — the resolved
// path, the same file — and the grant is how the first admin comes to be:
// there is no HTTP endpoint that hands the flag out, and chapter 46's
// server-side admin key is the bootstrap that will not need the CLI.
//
// The store's interface does not promise a database: it is the task contract,
// and users live beside the tasks, not in them. The grant asks the opened
// store for the capability it needs with a type assertion — TursoStore
// exposes its handle (DB), the in-memory store has none — and a store that
// cannot answer fails the command with a sentence that says so, instead of a
// nil dereference. The same idiom as the consumer-side interfaces elsewhere:
// ask for what you use, at the point you use it.

// adminStore is the capability the admin commands need from the opened store:
// the database handle the auth tables live in.
type adminStore interface {
	DB() *sql.DB
}

// newAdminCmd builds the admin command group.
func newAdminCmd(sess *session) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "admin",
		Short: "Operator commands over users",
		Long: `Operator commands over users.

These commands work on the database the CLI opened, like every other
command, and they are the local operator's: there is no HTTP endpoint that
grants the admin flag.`,
	}
	cmd.AddCommand(newAdminGrantCmd(sess))
	return cmd
}

// newAdminGrantCmd builds `todo admin grant <email>`: one positional email,
// the service's grant behind it, and the same two output formats as every
// other command.
func newAdminGrantCmd(sess *session) *cobra.Command {
	return &cobra.Command{
		Use:   "grant <email>",
		Short: "Grant the admin flag to a user",
		Long: `Grant the admin flag to the user with the given email.

The grant is recorded in the audit trail, and the actor is nobody: the local
operator runs the command and has no account of their own. An email no user
holds fails the command and changes nothing.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			st, ok := sess.store.(adminStore)
			if !ok {
				return fmt.Errorf("admin: the opened store does not expose a database (it is %T)", sess.store)
			}
			user, err := auth.NewService(st.DB()).GrantAdmin(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			sess.logger.Info("admin granted", "user_id", user.ID.String(), "email", user.Email)
			if sess.json {
				return writeJSON(cmd.OutOrStdout(), jsonUser{
					ID:      user.ID.String(),
					Email:   user.Email,
					IsAdmin: user.IsAdmin,
				})
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "granted admin to %s\n", user.Email)
			return err
		},
	}
}

// jsonUser is the machine form of a user for the admin commands: the id, the
// email, and the admin flag, under the stable-key discipline every --json
// shape follows. Change it additively — a renamed or retyped key is a
// breaking change.
type jsonUser struct {
	ID      string `json:"id"`
	Email   string `json:"email"`
	IsAdmin bool   `json:"is_admin"`
}
````


## `internal/cli/cli.go`

````go
// Package cli builds the todo command tree: the thin layer that parses
// arguments, calls the store, and formats what it reads. The tree is built
// around its dependencies — an opener for the store, a logger for the run's
// records, and two writers — instead of reaching for globals, so the
// commands are exercised in-process and the wiring stays in cmd/todo.
//
// Output and logs are separate channels: data goes to out (the writers
// cobra's commands print through), records go to the logger, and errOut
// carries only what cobra itself prints. A --json pipe must never see a log
// record, whichever format the records take.
//
// Every command has two output formats: the human default and --json. The
// JSON shapes are a small, documented API — see jsonTask, jsonStats, and
// jsonImport — so scripts can depend on them without depending on the human
// table's layout.
package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/google/uuid"
	"github.com/spf13/cobra"

	"todo/internal/config"
	"todo/internal/store"
	"todo/internal/task"
)

// OpenFunc creates the store at the resolved path; the returned cleanup runs
// when the command finishes.
type OpenFunc func(ctx context.Context, dbPath string) (store.Store, func() error, error)

// session is the state the commands share: the store the pre-run opened, the
// cleanup the post-run will call, the logger the run's records go to, and the
// output format the --json flag chose. One session per New call, reached
// through a pointer, so nothing about a run lives in a package global.
type session struct {
	store   store.Store
	cleanup func() error
	// logger receives the commands' action records. It is never the stdout
	// writer: logs and data are separate channels (see the package comment).
	logger *slog.Logger
	// json is the resolved --json flag. The flag is parsed before any RunE
	// runs, so the commands read this bool instead of the flag itself.
	json bool
}

// close runs the session's cleanup at most once. The post-run calls it after
// a successful command; nil-ing the field first makes a second call — the
// same tree executed twice — a no-op instead of a double close.
func (s *session) close() error {
	if s.cleanup == nil {
		return nil
	}
	cleanup := s.cleanup
	s.cleanup = nil
	return cleanup()
}

// New builds the todo command tree around an opener and a logger. The store
// is not passed in: the tree resolves the database path at run time — the
// persistent --db flag over $TODO_DB over the XDG default — and hands the
// resolved path to open, which builds the store the commands then share.
// Output goes to out and errOut so tests can capture it; log records go to
// logger, and never to out.
func New(open OpenFunc, logger *slog.Logger, out, errOut io.Writer) *cobra.Command {
	var (
		dbFlag   string
		logLevel logLevelFlag
		sess     session
	)
	sess.logger = logger
	root := &cobra.Command{
		Use:   "todo",
		Short: "A small todo list for the terminal",
		Long: `todo keeps a task list in a local Turso database.

Tasks have an id, a title, a status, a priority, an optional due date, and
tags. add prints the new task's id; that id is the handle the other commands
take.`,
		// Cobra's defaults are built for a program that lets cobra report
		// its own errors, and this one does not: main prints the error
		// once. SilenceErrors stops cobra from printing it too — without
		// it, every failure is printed twice — and SilenceUsage stops a
		// runtime failure like a bad id from dumping the full usage text
		// on top of the one error line.
		SilenceUsage:  true,
		SilenceErrors: true,
		// The pre-run hook is inherited by every command that executes, so
		// the level is applied, the resolution happens, and the open
		// happens once per run, before any command body touches the store.
		// config.Load is the precedence rule; the opener is the seam that
		// turns the resolved path into a store, and it receives the
		// resolved path, never the flag alone.
		PersistentPreRunE: func(cmd *cobra.Command, _ []string) error {
			// The flag's level is applied before anything logs. The
			// process logger's handler (internal/logging's tee) exposes
			// SetLevel; a logger without it keeps the level it was built
			// with, and the flag is validated but inert.
			if setter, ok := sess.logger.Handler().(levelSetter); ok {
				setter.SetLevel(logLevel.level)
			}
			cfg, err := config.Load(os.Getenv, dbFlag)
			if err != nil {
				return err
			}
			// The resolved paths are the first debug record: "why is my
			// data not where I thought" is exactly what a debug run is
			// for.
			sess.logger.Debug("config resolved", "db", cfg.DBPath, "log", cfg.LogPath)
			st, cleanup, err := open(cmd.Context(), cfg.DBPath)
			if err != nil {
				return err
			}
			sess.store, sess.cleanup = st, cleanup
			return nil
		},
		// The cleanup belongs to the tree, not to main: the opener handed
		// it back here, and main no longer closes the store itself —
		// keeping both would close the handle twice on the success path.
		// Cobra reaches the post-run only when RunE succeeds; the error
		// path is the process exiting, which releases the file (see the
		// chapter notes for the full trade-off).
		PersistentPostRunE: func(*cobra.Command, []string) error {
			return sess.close()
		},
	}
	// The writers reach cobra's own output too: help and the built-in
	// completion command print to out, so a test can capture those as well.
	root.SetOut(out)
	root.SetErr(errOut)

	// The flag's help states the precedence, because the flag is the top of
	// it: an empty value means "fall through to the environment", not
	// "open the empty path".
	root.PersistentFlags().StringVar(&dbFlag, "db", "",
		"path to the Turso database; overrides $TODO_DB and the XDG default")

	// --json is persistent so every command inherits it: one format switch
	// for the whole tree, not five copies, and the help lists it with --db
	// under Global Flags on every leaf.
	root.PersistentFlags().BoolVar(&sess.json, "json", false,
		"output JSON instead of the human-readable format")

	// The log threshold is validated while the flag is parsed: a typo must
	// fail the command, not silently change verbosity.
	root.PersistentFlags().Var(&logLevel, "log-level",
		"log threshold: debug, info, warn, or error")

	// rm is deliberately absent. Store has no Remove — after Add, the only
	// write the domain knows is Complete — and a delete command cannot be
	// faked without lying about what happened. It waits for the chapter
	// that grows the interface instead of being papered over with an
	// in-memory filter that would not persist.
	root.AddCommand(
		newAddCmd(&sess),
		newListCmd(&sess),
		newDoneCmd(&sess),
		newStatsCmd(&sess),
		newImportCmd(&sess),
		newAdminCmd(&sess),
		newVersionCmd(&sess),
	)
	return root
}

// levelSetter is the capability --log-level needs from the logger's handler:
// internal/logging's tee handler owns the LevelVar its two sinks share, so
// one SetLevel call retunes stderr and the log file together. Naming the
// interface here, at the user, keeps cli from importing the logging package.
type levelSetter interface {
	SetLevel(slog.Level)
}

// logLevelFlag is --log-level's pflag.Value. Its zero value is info — slog's
// own zero — so an unset flag reads as the default in help and in the
// pre-run. Set parses and validates; the resolved level is applied at
// pre-run time, not while parsing, so a second execution of one tree
// re-applies the flag's value instead of inheriting the last run's.
type logLevelFlag struct {
	level slog.Level
}

// String spells the level the way the flag does, so pflag prints
// "(default info)" and the help names the type it accepts.
func (f *logLevelFlag) String() string { return logLevelName(f.level) }

// Set parses one --log-level occurrence.
func (f *logLevelFlag) Set(value string) error {
	level, err := parseLogLevel(value)
	if err != nil {
		return err
	}
	f.level = level
	return nil
}

// Type names the value type in help: --log-level level.
func (f *logLevelFlag) Type() string { return "level" }

// parseLogLevel maps the flag's four names to slog levels. Anything else is
// an error, not a fallback: a typo must fail the command, never silently
// change verbosity.
func parseLogLevel(value string) (slog.Level, error) {
	switch value {
	case "debug":
		return slog.LevelDebug, nil
	case "info":
		return slog.LevelInfo, nil
	case "warn":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	}
	return 0, fmt.Errorf("unknown level %q: want debug, info, warn, or error", value)
}

// logLevelName is the inverse of parseLogLevel, for help and defaults.
func logLevelName(level slog.Level) string {
	switch level {
	case slog.LevelDebug:
		return "debug"
	case slog.LevelInfo:
		return "info"
	case slog.LevelWarn:
		return "warn"
	case slog.LevelError:
		return "error"
	}
	return level.String()
}

// newAddCmd builds the add command: one positional title, three flags, and
// the store's Add behind them. The flags are validated by the domain — the
// same ParseDue and Priority.Valid every other caller uses — so the CLI
// cannot drift from the rules.
func newAddCmd(sess *session) *cobra.Command {
	var (
		due      string
		priority int
		tags     []string
	)
	cmd := &cobra.Command{
		Use:   "add <title>",
		Short: "Add a task and print its id",
		Long: `Add a task and print its id.

The id is the handle the other commands take: done marks the task with it,
and list prints it first on every line.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			t, err := task.NewTask(args[0])
			if err != nil {
				return err
			}
			if cmd.Flags().Changed("due") {
				if t.Due, err = task.ParseDue(due, time.Now()); err != nil {
					return err
				}
			}
			p := task.Priority(priority)
			if !p.Valid() {
				return task.ValidationError{
					Field:   "priority",
					Message: fmt.Sprintf("must be between %d and %d", task.PriorityMin, task.PriorityMax),
				}
			}
			t.Priority = p
			t.Tags = tags

			stored, err := sess.store.Add(cmd.Context(), t)
			if err != nil {
				return err
			}
			sess.logger.Info("task added", "id", stored.ID.String(), "title", stored.Title)
			if sess.json {
				return writeJSON(cmd.OutOrStdout(), newJSONTask(stored))
			}
			_, err = fmt.Fprintln(cmd.OutOrStdout(), stored.ID)
			return err
		},
	}
	cmd.Flags().StringVar(&due, "due", "", `when it is due: "today", "tomorrow", or YYYY-MM-DD`)
	cmd.Flags().IntVar(&priority, "priority", int(task.PriorityDefault), "urgency from 1 (lowest) to 5 (highest)")
	cmd.Flags().StringArrayVar(&tags, "tag", nil, "attach a tag (repeatable)")
	return cmd
}

// newListCmd builds the list command. The two filters map onto the store's
// own queries; the store has no combined query yet, so the flags cannot be
// combined either — the error says so instead of silently dropping one.
func newListCmd(sess *session) *cobra.Command {
	var (
		status statusFlag
		tag    string
	)
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List tasks",
		Long: `List tasks in insertion order as an aligned table: id, status, title, and
the due date and tags when the task has them. --json prints one JSON object
per task instead, one object per line.

--status filters through the store's status query and --tag through its tag
query; combining the two has no store query behind it yet.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			var (
				tasks []task.Task
				err   error
			)
			switch {
			case cmd.Flags().Changed("status") && tag != "":
				return errors.New("--status and --tag cannot be combined yet")
			case cmd.Flags().Changed("status"):
				tasks, err = sess.store.ByStatus(ctx, status.status)
			case tag != "":
				tasks, err = sess.store.ByTag(ctx, tag)
			default:
				tasks, err = sess.store.List(ctx)
			}
			if err != nil {
				return err
			}
			if sess.json {
				// JSONL: one object per line, so a pipe sees whole tasks
				// and `list --json | head -1` reads one without waiting
				// for the rest.
				enc := json.NewEncoder(cmd.OutOrStdout())
				for _, t := range tasks {
					if err := enc.Encode(newJSONTask(t)); err != nil {
						return err
					}
				}
				return nil
			}
			return writeTaskTable(cmd.OutOrStdout(), tasks)
		},
	}
	cmd.Flags().Var(&status, "status", "filter by status (Todo or Done)")
	cmd.Flags().StringVar(&tag, "tag", "", "filter by tag")
	return cmd
}

// statusFlag adapts task.Status to pflag.Value, so --status is validated by
// the domain's own UnmarshalText while the flag is parsed and RunE receives a
// typed task.Status. pflag has no encoding.TextUnmarshaler hook, hence the
// three-method wrapper.
type statusFlag struct {
	status task.Status
}

// String returns the flag's current value; pflag prints it as the default.
func (f *statusFlag) String() string { return string(f.status) }

// Set parses one --status occurrence through the domain's UnmarshalText.
func (f *statusFlag) Set(value string) error {
	return f.status.UnmarshalText([]byte(value))
}

// Type names the value type in help: --status status.
func (f *statusFlag) Type() string { return "status" }

// newDoneCmd builds the done command. It reads the task first — Store has no
// Get, so the snapshot is a List and a scan — and hands the version it read
// back to Complete, which is what makes the write a compare-and-swap.
func newDoneCmd(sess *session) *cobra.Command {
	return &cobra.Command{
		Use:   "done <id>",
		Short: "Mark a task done",
		Long: `Mark the task with the given id done.

done reads the task first and hands the version it read back to the store, so
a task that changed in between fails instead of being overwritten. The id is
the one add printed.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			id, err := uuid.Parse(args[0])
			if err != nil {
				return fmt.Errorf("done: invalid id %q: %w", args[0], err)
			}
			t, err := findTask(ctx, sess.store, id)
			if err != nil {
				return err
			}
			if err := sess.store.Complete(ctx, id, t.Version); err != nil {
				return err
			}
			sess.logger.Info("task completed", "id", id.String(), "title", t.Title)
			if !sess.json {
				return nil
			}
			// The report is the stored task, re-read after the CAS: the
			// status and version printed are the store's, not a local
			// guess at what Complete did.
			updated, err := findTask(ctx, sess.store, id)
			if err != nil {
				return err
			}
			return writeJSON(cmd.OutOrStdout(), newJSONTask(updated))
		},
	}
}

// findTask returns the task with the given id from the store, wrapped in the
// done command's own sentence: the error names what the user ran — "done:
// task ..." — not the store operation, so a miss is reported as the store's
// ErrNotFound under the command's words rather than nested inside Get's.
//
// The read is Store.Get: one row. It used to be a List and a scan, from the
// chapter that wrote this command before Store had a Get — and chapter 50's
// hundred-thousand-task workload made the difference the fix: finding one
// task by reading all of them cost 383 MB and 1.6 s, where the targeted read
// costs 7.7 KB and 138 us. The version handed back is the one Complete
// checks either way: Get reads the same row List would have found.
func findTask(ctx context.Context, s store.Store, id uuid.UUID) (task.Task, error) {
	t, err := s.Get(ctx, id)
	switch {
	case errors.Is(err, store.ErrNotFound):
		return task.Task{}, fmt.Errorf("done: task %s: %w", id, store.ErrNotFound)
	case err != nil:
		return task.Task{}, err
	default:
		return t, nil
	}
}

// newStatsCmd builds the stats command: one call to the store's aggregate,
// three printed numbers. --json prints the same three numbers as one object.
func newStatsCmd(sess *session) *cobra.Command {
	return &cobra.Command{
		Use:   "stats",
		Short: "Show task totals",
		Long:  "Count the tasks: how many there are, how many are done, how many are pending.",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			stats, err := sess.store.Stats(cmd.Context())
			if err != nil {
				return err
			}
			if sess.json {
				return writeJSON(cmd.OutOrStdout(), jsonStats{
					Total:   stats.Total,
					Done:    stats.Done,
					Pending: stats.Pending,
				})
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "Total:   %d\nDone:    %d\nPending: %d\n",
				stats.Total, stats.Done, stats.Pending)
			return err
		},
	}
}

// newImportCmd builds the import command: a file path in, the importer's
// all-or-nothing read, and the count out.
func newImportCmd(sess *session) *cobra.Command {
	return &cobra.Command{
		Use:   "import <file>",
		Short: "Import tasks from a JSON document",
		Long: `Import every task in a JSON store document (version 1, 2, or 3) and print
how many landed.

The import is all-or-nothing: a document the importer rejects changes
nothing.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			f, err := os.Open(args[0]) // #nosec G304 -- the caller names the file to import; reading exactly that file is the command's purpose
			if err != nil {
				return fmt.Errorf("import: %w", err)
			}
			defer func() {
				// The document has been read by the time the deferred close
				// runs, and this handle only read; a close error cannot
				// change the outcome, so it is discarded explicitly.
				_ = f.Close()
			}()

			n, err := store.ImportJSON(cmd.Context(), sess.store, f)
			if err != nil {
				return err
			}
			sess.logger.Info("imported", "count", n)
			if sess.json {
				return writeJSON(cmd.OutOrStdout(), jsonImport{Imported: n})
			}
			noun := "tasks"
			if n == 1 {
				noun = "task"
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "imported %d %s\n", n, noun)
			return err
		},
	}
}

// writeTaskTable renders tasks as an aligned table: id, status, and title on
// every row, then the due date and tags. Every row uses one cell per column
// even when a value is empty, so tabwriter can align a column across the
// whole listing; the padding is then stripped from line ends, because it is
// invisible but real, and pipes should not carry it.
func writeTaskTable(w io.Writer, tasks []task.Task) error {
	var buf bytes.Buffer
	tw := tabwriter.NewWriter(&buf, 0, 0, 2, ' ', 0)
	for _, t := range tasks {
		due := ""
		if !t.Due.IsZero() {
			due = t.Due.Format("2006-01-02")
		}
		if _, err := fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n",
			t.ID, t.Status, t.Title, due, strings.Join(t.Tags, ", ")); err != nil {
			return err
		}
	}
	if err := tw.Flush(); err != nil {
		return err
	}
	for line := range strings.Lines(buf.String()) {
		if _, err := io.WriteString(w, strings.TrimRight(line, " \t\n")+"\n"); err != nil {
			return err
		}
	}
	return nil
}

// jsonTask is the machine-readable form of a task. Its field names are the
// stable contract of every --json output that carries a task: list emits one
// per line (JSONL), add and done emit one object each. The shape is an API:
// keys are lowercase; due is an RFC 3339 timestamp or null when the task has
// no due date; tags is always an array, never null; version is the
// optimistic-concurrency counter. Change it additively — a renamed or
// retyped key is a breaking change.
type jsonTask struct {
	ID       string     `json:"id"`
	Title    string     `json:"title"`
	Status   string     `json:"status"`
	Priority int        `json:"priority"`
	Due      *time.Time `json:"due"`
	Tags     []string   `json:"tags"`
	Version  int        `json:"version"`
}

// newJSONTask converts a domain task to its wire form. The copy is what
// makes the output stable: this DTO owns the key names and the null rules,
// not the domain type's own marshaling.
func newJSONTask(t task.Task) jsonTask {
	jt := jsonTask{
		ID:       t.ID.String(),
		Title:    t.Title,
		Status:   t.Status.String(),
		Priority: int(t.Priority),
		Tags:     t.Tags,
		Version:  t.Version,
	}
	if jt.Tags == nil {
		jt.Tags = []string{}
	}
	if !t.Due.IsZero() {
		due := t.Due
		jt.Due = &due
	}
	return jt
}

// jsonStats is stats --json's object: the same three numbers as the human
// block, under the same stable-key discipline.
type jsonStats struct {
	Total   int `json:"total"`
	Done    int `json:"done"`
	Pending int `json:"pending"`
}

// jsonImport is import --json's object: how many tasks landed.
type jsonImport struct {
	Imported int `json:"imported"`
}

// writeJSON encodes v as one JSON object followed by a newline — the single-
// object shape add, done, stats, and import share. list writes its own
// stream, because JSONL is many objects, one per line.
func writeJSON(w io.Writer, v any) error {
	return json.NewEncoder(w).Encode(v)
}
````


## `internal/cli/cli_test.go`

````go
package cli_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/gkampitakis/go-snaps/snaps"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/auth"
	"todo/internal/cli"
	"todo/internal/logging"
	"todo/internal/store"
	"todo/internal/task"
)

// opener is a fake OpenFunc: it records every path the tree resolves, hands
// the commands the store the test seeded, and counts the cleanup runs. The
// precedence tests assert on the recorded path, so no database file has to
// exist anywhere for them.
type opener struct {
	store store.Store
	err   error

	paths    []string
	cleanups int
}

// open matches cli.OpenFunc.
func (o *opener) open(_ context.Context, dbPath string) (store.Store, func() error, error) {
	o.paths = append(o.paths, dbPath)
	if o.err != nil {
		return nil, nil, o.err
	}
	return o.store, func() error {
		o.cleanups++
		return nil
	}, nil
}

// The fake and the production opener are the same seam: if OpenFunc's
// signature moves, this line stops compiling.
var _ cli.OpenFunc = (&opener{}).open

// runCLIWith is the test seam. New takes the opener, the logger, and the
// writers, so exercising the CLI is an ordinary function call: build a fresh
// tree around o, point it at the arguments, run it, and hand back everything
// it printed. The logger discards its records here — these cases are about
// what the commands print and return; the logging section below reads
// records back from a buffer instead. No process, no os.Stdout, no
// package-level state between cases.
func runCLIWith(t *testing.T, o *opener, args ...string) (stdout, stderr string, err error) {
	t.Helper()
	return runCLIWithLogger(t, o, slog.New(slog.DiscardHandler), args...)
}

// runCLIWithLogger is runCLIWith with a caller-supplied logger: the seam the
// logging cases use to capture records in a buffer.
func runCLIWithLogger(t *testing.T, o *opener, logger *slog.Logger, args ...string) (stdout, stderr string, err error) {
	t.Helper()
	var out, errOut bytes.Buffer
	root := cli.New(o.open, logger, &out, &errOut)
	root.SetArgs(args)
	err = root.ExecuteContext(context.Background())
	return out.String(), errOut.String(), err
}

// runCLI runs one command against a fresh tree over st.
func runCLI(t *testing.T, st store.Store, args ...string) (stdout, stderr string, err error) {
	t.Helper()
	return runCLIWith(t, &opener{store: st}, args...)
}

// uuidPattern matches the canonical string form of a UUID anywhere in the
// output. The commands print the ids the stores assigned, and UUIDv7 ids are
// random values that change on every run, so a snapshot cannot pin them.
var uuidPattern = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)

// normalizeIDs replaces every UUID in s with the placeholder <id>. The
// snapshot then pins the output's shape and order — the part that is the
// program's behavior — while the volatile id values stay out of the golden.
// go-snaps has no transform hook, so the normalization happens here, before
// MatchSnapshot sees the string.
func normalizeIDs(s string) string {
	return uuidPattern.ReplaceAllString(s, "<id>")
}

// TestDBPathPrecedence drives the resolution end-to-end through SetArgs: the
// --db flag beats TODO_DB, TODO_DB beats the XDG default, and an empty flag
// falls through to the next source. The opener records the path it would
// have opened, so each case asserts the resolved path without a database
// existing. The test is not parallel: t.Setenv writes the process
// environment, and Go forbids that next to t.Parallel.
func TestDBPathPrecedence(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	t.Run("the flag beats the environment", func(t *testing.T) {
		t.Setenv("TODO_DB", filepath.Join(home, "env.db"))
		flag := filepath.Join(home, "flag.db")

		o := &opener{store: store.NewMemoryStore()}
		_, _, err := runCLIWith(t, o, "--db", flag, "list")
		require.NoError(t, err)
		assert.Equal(t, []string{flag}, o.paths)
	})

	t.Run("the environment beats the XDG default", func(t *testing.T) {
		env := filepath.Join(home, "env.db")
		t.Setenv("TODO_DB", env)
		t.Setenv("XDG_DATA_HOME", filepath.Join(home, "xdg-data"))

		o := &opener{store: store.NewMemoryStore()}
		_, _, err := runCLIWith(t, o, "list")
		require.NoError(t, err)
		assert.Equal(t, []string{env}, o.paths)
	})

	t.Run("the default is the XDG data directory", func(t *testing.T) {
		t.Setenv("TODO_DB", "")
		xdg := filepath.Join(home, "xdg-data")
		t.Setenv("XDG_DATA_HOME", xdg)

		o := &opener{store: store.NewMemoryStore()}
		_, _, err := runCLIWith(t, o, "list")
		require.NoError(t, err)
		assert.Equal(t, []string{filepath.Join(xdg, "todo", "todo.db")}, o.paths)
	})

	t.Run("an empty flag falls through to the environment", func(t *testing.T) {
		env := filepath.Join(home, "env.db")
		t.Setenv("TODO_DB", env)

		o := &opener{store: store.NewMemoryStore()}
		_, _, err := runCLIWith(t, o, "--db", "", "list")
		require.NoError(t, err)
		assert.Equal(t, []string{env}, o.paths)
	})
}

// TestRun_OpensResolvedPathAndCleansUp pins the other half of the seam: the
// commands' store comes from the opener — the path is resolved, not
// hard-coded — and the cleanup the opener returned runs when the command
// finishes.
func TestRun_OpensResolvedPathAndCleansUp(t *testing.T) {
	t.Setenv("TODO_DB", filepath.Join(t.TempDir(), "todo.db"))

	st := store.NewMemoryStore()
	o := &opener{store: st}
	out, _, err := runCLIWith(t, o, "add", "buy milk")
	require.NoError(t, err)
	assert.Len(t, o.paths, 1, "one command opens the store once")
	assert.Equal(t, 1, o.cleanups, "the cleanup runs when the command finishes")

	list, err := st.List(context.Background())
	require.NoError(t, err)
	require.Len(t, list, 1, "the command wrote through the opened store")
	assert.Equal(t, list[0].ID.String()+"\n", out)
}

// TestRun_OpenError pins that a store that cannot be opened stops the
// command before its body runs.
func TestRun_OpenError(t *testing.T) {
	t.Parallel()

	o := &opener{err: errors.New("disk on fire")}
	_, _, err := runCLIWith(t, o, "list")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "disk on fire")
}

// TestRun_RealStoreIsQuiet runs the real CLI — the real opener and the real
// Turso store, migrations and all — in a scratch directory and pins that
// the open prints nothing: goose's default logger routes through the stdlib
// log package, so pointing that package at a buffer captures exactly the
// migration noise this chapter silences. The test is sequential because log's
// output is process-global; the parallel tests in this package are paused
// while it runs.
func TestRun_RealStoreIsQuiet(t *testing.T) {
	var noise bytes.Buffer
	log.SetOutput(&noise)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })

	dir := t.TempDir()
	open := func(ctx context.Context, dbPath string) (store.Store, func() error, error) {
		st, err := store.NewTursoStore(ctx, dbPath)
		if err != nil {
			return nil, nil, err
		}
		return st, st.Close, nil
	}

	var out, errOut bytes.Buffer
	root := cli.New(open, slog.New(slog.DiscardHandler), &out, &errOut)
	root.SetArgs([]string{"--db", filepath.Join(dir, "todo.db"), "add", "buy milk"})
	require.NoError(t, root.ExecuteContext(context.Background()))

	assert.NotEmpty(t, out.String(), "add printed the id")
	assert.Empty(t, errOut.String(), "cobra's stderr stays clean")
	assert.Empty(t, noise.String(), "the store's open is silent on stderr")
}

// seedTask stores one task with each mutate applied and returns the stored
// copy: the snapshot with the id and version the CLI reads back.
func seedTask(t *testing.T, s store.Store, title string, mutate ...func(*task.Task)) task.Task {
	t.Helper()
	tt, err := task.NewTask(title)
	require.NoError(t, err)
	for _, m := range mutate {
		m(&tt)
	}
	stored, err := s.Add(context.Background(), tt)
	require.NoError(t, err)
	return stored
}

// due2026 is the fixed due date the deterministic cases share.
var due2026 = time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)

// TestAdd pins that the positional title and the flags land in the store and
// that the printed id is the handle the store assigned.
func TestAdd(t *testing.T) {
	t.Parallel()

	t.Run("args and flags land in the stored task", func(t *testing.T) {
		t.Parallel()

		st := store.NewMemoryStore()
		out, _, err := runCLI(t, st, "add", "buy milk", "--due", "2026-11-01", "--priority", "5", "--tag", "home", "--tag", "work")
		require.NoError(t, err)

		list, err := st.List(context.Background())
		require.NoError(t, err)
		require.Len(t, list, 1)
		got := list[0]
		assert.Equal(t, "buy milk", got.Title)
		assert.Equal(t, task.StatusTodo, got.Status)
		assert.Equal(t, task.PriorityMax, got.Priority)
		assert.Equal(t, due2026, got.Due)
		assert.Equal(t, []string{"home", "work"}, got.Tags)
		assert.Equal(t, got.ID.String()+"\n", out, "add prints the id the store assigned")
	})

	t.Run("--due tomorrow parses", func(t *testing.T) {
		t.Parallel()

		st := store.NewMemoryStore()
		_, _, err := runCLI(t, st, "add", "call mom", "--due", "tomorrow")
		require.NoError(t, err)

		list, err := st.List(context.Background())
		require.NoError(t, err)
		require.Len(t, list, 1)
		got := list[0]
		// ParseDue resolves "tomorrow" against the command's own time.Now,
		// so the expected date is one of two: the test's tomorrow, or its
		// today when midnight crossed between the command and this check.
		now := time.Now().UTC()
		today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
		assert.Contains(t, []time.Time{today, today.AddDate(0, 0, 1)}, got.Due)
	})
}

// TestAdd_InvalidDue pins that a due date the domain refuses fails the
// command and leaves the store untouched.
func TestAdd_InvalidDue(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	_, _, err := runCLI(t, st, "add", "buy milk", "--due", "not-a-date")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unrecognized date")

	list, err := st.List(context.Background())
	require.NoError(t, err)
	assert.Empty(t, list, "a bad due date adds nothing")
}

// TestAdd_InvalidPriority pins that priority validation is the domain's:
// --priority outside 1-5 fails the command and leaves the store untouched.
func TestAdd_InvalidPriority(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	_, _, err := runCLI(t, st, "add", "buy milk", "--priority", "9")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "priority")

	list, err := st.List(context.Background())
	require.NoError(t, err)
	assert.Empty(t, list, "a bad priority adds nothing")
}

// TestAdd_JSON pins add's machine form: the stored task as one JSON object,
// the same shape list --json emits per line.
func TestAdd_JSON(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	out, _, err := runCLI(t, st, "add", "buy milk",
		"--due", "2026-11-01", "--priority", "5", "--tag", "home", "--json")
	require.NoError(t, err)

	var got wireTask
	dec := json.NewDecoder(strings.NewReader(out))
	dec.DisallowUnknownFields()
	require.NoError(t, dec.Decode(&got))

	list, err := st.List(context.Background())
	require.NoError(t, err)
	require.Len(t, list, 1)
	assert.Equal(t, list[0].ID.String(), got.ID)
	assert.Equal(t, "buy milk", got.Title)
	assert.Equal(t, task.StatusTodo.String(), got.Status)
	assert.Equal(t, int(task.PriorityMax), got.Priority)
	require.NotNil(t, got.Due)
	assert.True(t, due2026.Equal(*got.Due))
	assert.Equal(t, []string{"home"}, got.Tags)
	assert.Equal(t, 1, got.Version)
}

// listStore seeds the list fixture: three pending tasks — one with a due
// date and a tag, one plain, and one with a tag but no due date — and one
// done task, in insertion order. The tags-only task is what pins the empty
// due cell: its tags still line up under the first task's.
func listStore(t *testing.T) (st store.Store, milk, book, shipped, plants task.Task) {
	t.Helper()
	st = store.NewMemoryStore()
	milk = seedTask(t, st, "buy milk", func(t *task.Task) {
		t.Due = due2026
		t.Tags = []string{"home"}
	})
	book = seedTask(t, st, "write the book", func(t *task.Task) {
		t.Priority = task.PriorityMax
	})
	shipped = seedTask(t, st, "ship it")
	require.NoError(t, st.Complete(context.Background(), shipped.ID, shipped.Version))
	plants = seedTask(t, st, "water the plants", func(t *task.Task) {
		t.Tags = []string{"garden"}
	})
	return st, milk, book, shipped, plants
}

// TestList pins the aligned table format and the two store-backed filters.
// The fixture is seeded through the store, not the CLI, so a failure here is
// the list command's, not add's.
func TestList(t *testing.T) {
	t.Parallel()

	t.Run("plain lists every task in insertion order", func(t *testing.T) {
		t.Parallel()

		st, milk, book, shipped, plants := listStore(t)
		out, _, err := runCLI(t, st, "list")
		require.NoError(t, err)

		want := milk.ID.String() + "  Todo  buy milk          2026-11-01  home\n" +
			book.ID.String() + "  Todo  write the book\n" +
			shipped.ID.String() + "  Done  ship it\n" +
			plants.ID.String() + "  Todo  water the plants              garden\n"
		assert.Equal(t, want, out)
	})

	t.Run("--status filters", func(t *testing.T) {
		t.Parallel()

		st, _, _, shipped, _ := listStore(t)
		out, _, err := runCLI(t, st, "list", "--status", "Done")
		require.NoError(t, err)
		assert.Equal(t, shipped.ID.String()+"  Done  ship it\n", out)
	})

	t.Run("--tag filters", func(t *testing.T) {
		t.Parallel()

		st, milk, _, _, _ := listStore(t)
		out, _, err := runCLI(t, st, "list", "--tag", "home")
		require.NoError(t, err)
		assert.Equal(t, milk.ID.String()+"  Todo  buy milk  2026-11-01  home\n", out)
	})
}

// TestList_Snapshots pins the two list formats as goldens: the aligned human
// table and the JSONL stream. The ids are random, so normalizeIDs replaces
// them with <id> before the snapshot sees the output; the fixture's titles,
// statuses, due date, and tags are fixed.
func TestList_Snapshots(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		args []string
	}{
		{name: "human table", args: []string{"list"}},
		{name: "jsonl", args: []string{"list", "--json"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			st, _, _, _, _ := listStore(t)
			out, _, err := runCLI(t, st, tt.args...)
			require.NoError(t, err)
			snaps.WithConfig(snaps.Raw()).MatchSnapshot(t, normalizeIDs(out))
		})
	}
}

// wireTask mirrors the documented --json task shape. The test owns its own
// copy of the contract on purpose: it is a separate type from the one the
// CLI encodes, so a renamed key on either side fails here instead of
// matching silently.
type wireTask struct {
	ID       string     `json:"id"`
	Title    string     `json:"title"`
	Status   string     `json:"status"`
	Priority int        `json:"priority"`
	Due      *time.Time `json:"due"`
	Tags     []string   `json:"tags"`
	Version  int        `json:"version"`
}

// TestList_JSONContract pins the machine shape of list --json: one JSON
// object per line, with exactly the documented keys. Decoding into wireTask
// proves the field names and types consumers rely on; decoding into a map
// proves no undocumented field is emitted. Together they make the key set an
// API: adding a field updates this test on purpose, renaming one fails it.
func TestList_JSONContract(t *testing.T) {
	t.Parallel()

	st, milk, book, shipped, plants := listStore(t)
	out, _, err := runCLI(t, st, "list", "--json")
	require.NoError(t, err)
	require.True(t, strings.HasSuffix(out, "\n"), "JSONL ends every object with a newline")

	lines := strings.Split(strings.TrimSuffix(out, "\n"), "\n")
	require.Len(t, lines, 4, "one JSON object per task")

	wantKeys := []string{"due", "id", "priority", "status", "tags", "title", "version"}
	wantIDs := []string{
		milk.ID.String(),
		book.ID.String(),
		shipped.ID.String(),
		plants.ID.String(),
	}

	var got []wireTask
	for i, line := range lines {
		var keys map[string]json.RawMessage
		require.NoError(t, json.Unmarshal([]byte(line), &keys), "line %d is one JSON object", i)
		assert.Equal(t, wantKeys, slices.Sorted(maps.Keys(keys)), "line %d carries exactly the documented keys", i)

		dec := json.NewDecoder(strings.NewReader(line))
		dec.DisallowUnknownFields()
		var wt wireTask
		require.NoError(t, dec.Decode(&wt), "line %d decodes into the documented struct", i)
		assert.Equal(t, wantIDs[i], wt.ID)
		got = append(got, wt)
	}

	assert.Equal(t, "buy milk", got[0].Title)
	require.NotNil(t, got[0].Due, "a due date is RFC 3339, not null")
	assert.True(t, due2026.Equal(*got[0].Due))
	assert.Equal(t, []string{"home"}, got[0].Tags)

	assert.Nil(t, got[1].Due, "no due date is null")
	assert.Equal(t, []string{}, got[1].Tags, "tags is an array even when the task has none")

	assert.Equal(t, task.StatusDone.String(), got[2].Status)
	assert.Equal(t, int(task.PriorityMax), got[1].Priority)
	assert.Equal(t, []string{"garden"}, got[3].Tags)
}

// TestDone pins the compare-and-swap: the command reads the task, hands the
// version it read to Complete, and a missing id is ErrNotFound.
func TestDone(t *testing.T) {
	t.Parallel()

	t.Run("marks the task done", func(t *testing.T) {
		t.Parallel()

		st := store.NewMemoryStore()
		added := seedTask(t, st, "buy milk")

		out, _, err := runCLI(t, st, "done", added.ID.String())
		require.NoError(t, err)
		assert.Empty(t, out, "done prints nothing when the write lands")

		list, err := st.List(context.Background())
		require.NoError(t, err)
		require.Len(t, list, 1)
		assert.Equal(t, task.StatusDone, list[0].Status)
		assert.Equal(t, added.Version+1, list[0].Version, "the CAS moves the version with the status")
	})

	t.Run("unknown id is ErrNotFound and names the id", func(t *testing.T) {
		t.Parallel()

		st := store.NewMemoryStore()
		missing := uuid.MustParse("00000000-0000-0000-0000-000000000042")

		_, _, err := runCLI(t, st, "done", missing.String())
		require.Error(t, err)
		assert.ErrorIs(t, err, store.ErrNotFound)
		assert.Contains(t, err.Error(), missing.String())
	})
}

// TestDone_JSON pins done's machine form: the task the store now holds,
// re-read after the compare-and-swap, so the version and status printed are
// the store's, not a client-side guess.
func TestDone_JSON(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	added := seedTask(t, st, "buy milk")

	out, _, err := runCLI(t, st, "done", added.ID.String(), "--json")
	require.NoError(t, err)

	var got wireTask
	dec := json.NewDecoder(strings.NewReader(out))
	dec.DisallowUnknownFields()
	require.NoError(t, dec.Decode(&got))

	assert.Equal(t, added.ID.String(), got.ID)
	assert.Equal(t, "buy milk", got.Title)
	assert.Equal(t, task.StatusDone.String(), got.Status)
	assert.Equal(t, added.Version+1, got.Version, "the CAS moves the version with the status")
	assert.Nil(t, got.Due)
	assert.Equal(t, []string{}, got.Tags)
}

// statsStore seeds the stats fixture: two pending tasks and one done task.
func statsStore(t *testing.T) store.Store {
	t.Helper()
	st := store.NewMemoryStore()
	seedTask(t, st, "buy milk")
	seedTask(t, st, "write the book")
	shipped := seedTask(t, st, "ship it")
	require.NoError(t, st.Complete(context.Background(), shipped.ID, shipped.Version))
	return st
}

// TestStats pins the human totals block.
func TestStats(t *testing.T) {
	t.Parallel()

	st := statsStore(t)
	out, _, err := runCLI(t, st, "stats")
	require.NoError(t, err)
	assert.Equal(t, "Total:   3\nDone:    1\nPending: 2\n", out)
}

// TestStats_Snapshots pins both stats formats as goldens. Neither contains an
// id, so normalizeIDs is a no-op here; it runs anyway because the snapshot
// call sites share one shape.
func TestStats_Snapshots(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		args []string
	}{
		{name: "human", args: []string{"stats"}},
		{name: "json", args: []string{"stats", "--json"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			st := statsStore(t)
			out, _, err := runCLI(t, st, tt.args...)
			require.NoError(t, err)
			snaps.WithConfig(snaps.Raw()).MatchSnapshot(t, normalizeIDs(out))
		})
	}
}

// v3Doc is a minimal version-3 document: the current format, two tasks.
const v3Doc = `{"version":3,"tasks":[
	{"ID":"0199c0de-0000-7000-8000-000000000001","Title":"write tests","Status":"Todo","Priority":3,"Version":1},
	{"ID":"0199c0de-0000-7000-8000-000000000002","Title":"review code","Status":"Done","Priority":5,"Version":2}
]}`

// writeTempFile writes content to a file in a test-owned directory and
// returns its path.
func writeTempFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "tasks.json")
	require.NoError(t, os.WriteFile(path, []byte(content), 0o600))
	return path
}

// TestImport pins that the import command prints the count the importer
// returns and that a malformed document fails without changing the store.
func TestImport(t *testing.T) {
	t.Parallel()

	t.Run("a v3 document is imported and counted", func(t *testing.T) {
		t.Parallel()

		path := writeTempFile(t, v3Doc)

		st := store.NewMemoryStore()
		out, _, err := runCLI(t, st, "import", path)
		require.NoError(t, err)
		assert.Equal(t, "imported 2 tasks\n", out)

		list, err := st.List(context.Background())
		require.NoError(t, err)
		assert.Len(t, list, 2)
	})

	t.Run("a malformed document fails", func(t *testing.T) {
		t.Parallel()

		path := writeTempFile(t, `{"version":3,"tasks":[`)

		st := store.NewMemoryStore()
		_, _, err := runCLI(t, st, "import", path)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "import tasks")

		list, err := st.List(context.Background())
		require.NoError(t, err)
		assert.Empty(t, list, "a malformed document imports nothing")
	})
}

// TestImport_JSON pins the import report: one object with the count.
func TestImport_JSON(t *testing.T) {
	t.Parallel()

	path := writeTempFile(t, v3Doc)

	st := store.NewMemoryStore()
	out, _, err := runCLI(t, st, "import", path, "--json")
	require.NoError(t, err)
	assert.Equal(t, "{\"imported\":2}\n", out)
}

// TestJSON_ErrorLeavesStdoutEmpty pins the output discipline: a failing
// command writes nothing to stdout in either format, whatever --json says.
// The one error line belongs to main, on stderr; cobra stays silent.
func TestJSON_ErrorLeavesStdoutEmpty(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	out, errOut, err := runCLI(t, st, "add", "buy milk", "--due", "not-a-date", "--json")
	require.Error(t, err)
	assert.Empty(t, out, "stdout carries only the requested format, and there is none")
	assert.Empty(t, errOut, "cobra stays silent; the error is returned to the caller")
}

// newJSONLogger builds the process logger over a buffer: the stderr half is
// JSON, because a buffer is not a TTY — the format these cases parse — and
// the file half lands in a test-owned path. It returns the buffer both sinks
// are mirrored to.
func newJSONLogger(t *testing.T, level slog.Level) (*slog.Logger, *bytes.Buffer) {
	t.Helper()
	buf := new(bytes.Buffer)
	logger, closer, err := logging.New(buf, false, filepath.Join(t.TempDir(), "todo.log"), level)
	require.NoError(t, err)
	t.Cleanup(func() { _ = closer.Close() })
	return logger, buf
}

// TestLogging_AddEmitsRecord pins the add command's record: the logger gets
// one JSON line with the message and the stored task's id and title, while
// stdout stays exactly the id line — the record is not data.
func TestLogging_AddEmitsRecord(t *testing.T) {
	t.Parallel()

	logger, buf := newJSONLogger(t, slog.LevelInfo)

	st := store.NewMemoryStore()
	out, errOut, err := runCLIWithLogger(t, &opener{store: st}, logger, "add", "buy milk")
	require.NoError(t, err)

	list, err := st.List(context.Background())
	require.NoError(t, err)
	require.Len(t, list, 1)

	var rec struct {
		Level string `json:"level"`
		Msg   string `json:"msg"`
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	require.NoError(t, json.Unmarshal(buf.Bytes(), &rec), "one JSON record: %q", buf.String())
	assert.Equal(t, "INFO", rec.Level)
	assert.Equal(t, "task added", rec.Msg)
	assert.Equal(t, list[0].ID.String(), rec.ID)
	assert.Equal(t, "buy milk", rec.Title)

	assert.Equal(t, list[0].ID.String()+"\n", out, "stdout carries the id and only the id")
	assert.Empty(t, errOut, "cobra's stderr stays clean; the record went to the logger")
}

// TestLogging_LevelFlag pins --log-level in both directions. warn suppresses
// the info record; debug lowers the threshold enough to emit the pre-run's
// resolved-path line even though the logger was built at info — the flag
// retunes the process logger, it does not just drop one call.
func TestLogging_LevelFlag(t *testing.T) {
	t.Parallel()

	t.Run("warn suppresses the info record", func(t *testing.T) {
		t.Parallel()

		logger, buf := newJSONLogger(t, slog.LevelInfo)
		_, _, err := runCLIWithLogger(t, &opener{store: store.NewMemoryStore()}, logger,
			"--log-level", "warn", "add", "buy milk")
		require.NoError(t, err)
		assert.Empty(t, buf.String(), "no record at info level")
	})

	t.Run("debug emits the resolved paths", func(t *testing.T) {
		t.Parallel()

		logger, buf := newJSONLogger(t, slog.LevelInfo)
		dbPath := filepath.Join(t.TempDir(), "todo.db")

		_, _, err := runCLIWithLogger(t, &opener{store: store.NewMemoryStore()}, logger,
			"--db", dbPath, "--log-level", "debug", "list")
		require.NoError(t, err)

		var rec struct {
			Level string `json:"level"`
			Msg   string `json:"msg"`
			DB    string `json:"db"`
			Log   string `json:"log"`
		}
		require.NoError(t, json.Unmarshal(buf.Bytes(), &rec), "one JSON record: %q", buf.String())
		assert.Equal(t, "DEBUG", rec.Level)
		assert.Equal(t, "config resolved", rec.Msg)
		assert.Equal(t, dbPath, rec.DB)
		assert.NotEmpty(t, rec.Log, "the record names the log path too")
	})
}

// TestLogging_InvalidLevel pins the flag's validation: an unknown name is an
// error raised while the flag is parsed, not a silent fallback to the
// default.
func TestLogging_InvalidLevel(t *testing.T) {
	t.Parallel()

	_, _, err := runCLI(t, store.NewMemoryStore(), "--log-level", "loud", "list")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unknown level")
}

// TestAdminGrant pins the operator's command: the flag lands on the user, the
// grant is on the audit trail with no actor — the local CLI is not a user —
// an unknown email is the service's sentinel, and a store without a database
// cannot serve the command at all.
func TestAdminGrant(t *testing.T) {
	t.Parallel()

	st, err := store.NewTursoStore(context.Background(), filepath.Join(t.TempDir(), "todo.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, st.Close()) })
	svc := auth.NewService(st.DB())
	user, err := svc.Register(context.Background(), "alice@example.com", "correct horse battery staple")
	require.NoError(t, err)

	t.Run("the flag lands and the trail records it", func(t *testing.T) {
		out, _, err := runCLI(t, st, "admin", "grant", "alice@example.com")
		require.NoError(t, err)
		assert.Equal(t, "granted admin to alice@example.com\n", out)

		var isAdmin int
		require.NoError(t, st.DB().QueryRow(`SELECT is_admin FROM users WHERE email = ?`, "alice@example.com").Scan(&isAdmin))
		assert.Equal(t, 1, isAdmin)

		var action string
		var actor sql.NullString
		require.NoError(t, st.DB().QueryRow(
			`SELECT action, actor_id FROM audit_events WHERE user_id = ? AND action = 'grant'`, user.ID.String()).Scan(&action, &actor))
		assert.Equal(t, "grant", action)
		assert.False(t, actor.Valid, "the CLI is not a user")
	})

	t.Run("--json prints the granted user", func(t *testing.T) {
		_, err := svc.Register(context.Background(), "bob@example.com", "correct horse battery staple")
		require.NoError(t, err)

		out, _, err := runCLI(t, st, "admin", "grant", "bob@example.com", "--json")
		require.NoError(t, err)

		var got struct {
			ID      string `json:"id"`
			Email   string `json:"email"`
			IsAdmin bool   `json:"is_admin"`
		}
		dec := json.NewDecoder(strings.NewReader(out))
		dec.DisallowUnknownFields()
		require.NoError(t, dec.Decode(&got))
		assert.Equal(t, "bob@example.com", got.Email)
		assert.True(t, got.IsAdmin)
		assert.NotEmpty(t, got.ID)
	})

	t.Run("an unknown email is ErrUserNotFound", func(t *testing.T) {
		_, _, err := runCLI(t, st, "admin", "grant", "nobody@example.com")
		require.ErrorIs(t, err, auth.ErrUserNotFound)
	})

	t.Run("a store without a database cannot serve it", func(t *testing.T) {
		_, _, err := runCLI(t, store.NewMemoryStore(), "admin", "grant", "alice@example.com")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "database")
	})
}
````


## `internal/cli/version.go`

````go
package cli

import (
	"fmt"

	"github.com/spf13/cobra"

	"todo/internal/version"
)

// newVersionCmd builds the version command: the release's answer to "which
// build is this?", and the one command that answers without a store. It
// replaces the tree's pre-run hook with an empty one — cobra runs the
// closest PersistentPreRunE, not every ancestor's — so no database path is
// resolved and no store is opened: a release user runs `todo version` before
// any data exists, and the command must not create any. The process logger
// main built still exists; this command writes no records.
func newVersionCmd(sess *session) *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print the version",
		Long: `Print the version this binary was built with.

Release binaries are stamped at build time from the tag they were built
for; a binary built from a working tree reports "dev".`,
		Args: cobra.NoArgs,
		// The store is opened by the root's pre-run; version answers
		// without a database, so it overrides the hook with an empty one.
		PersistentPreRunE: func(*cobra.Command, []string) error { return nil },
		RunE: func(cmd *cobra.Command, _ []string) error {
			if sess.json {
				return writeJSON(cmd.OutOrStdout(), jsonVersion{Version: version.Version})
			}
			_, err := fmt.Fprintln(cmd.OutOrStdout(), version.Version)
			return err
		},
	}
}

// jsonVersion is version --json's object: one key, under the same
// stable-key discipline as every other command's JSON.
type jsonVersion struct {
	Version string `json:"version"`
}
````
