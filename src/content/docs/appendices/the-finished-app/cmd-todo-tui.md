---
title: "cmd/todo-tui — the finished app"
sidebar:
  hidden: true
tableOfContents: false
pagefind: false
---


Part of [The finished app (spoilers)](/appendices/the-finished-app/).


## `cmd/todo-tui/main.go`

````go
// Command todo-tui is the todo application's terminal UI: a Bubble Tea
// program over the HTTP API. It signs in like any other API client — the
// session cookie lands in internal/client's jar — and every list, add, and
// complete is one request to the server the CLI's database lives behind. The
// wiring is this file — configuration, the logger, the client, the program —
// and the model lives in internal/tui.
//
// The program's records go to the log file and nowhere else: a full-screen
// app owns the terminal it is drawing on, and a record written to stdout or
// stderr would land inside the frame. main resolves the same log path the
// CLI resolves — $TODO_LOG, else the XDG state default — with --debug-log on
// top for one session's debugging, and the model's commands write their
// failures there.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	tea "github.com/charmbracelet/bubbletea"

	"todo/internal/client"
	"todo/internal/config"
	"todo/internal/logging"
	"todo/internal/tui"
	"todo/internal/version"
)

// main is the process's only job: exit with run's code.
func main() {
	os.Exit(run())
}

// run resolves the configuration, builds the logger and the client, and runs
// the program. It returns the process's exit code: 0 after a clean quit, 1
// after printing the one error line.
func run() int {
	// A first interrupt or SIGTERM cancels ctx: a request in flight — a
	// login, a load — aborts with a context error instead of the process
	// dying mid-call. The program's own exit on a signal is Bubble Tea's —
	// it quits the event loop and restores the terminal — so this context
	// is only the commands'.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Two flags, so the stdlib flag package is still enough — the same
	// choice cmd/todo-server made. A parse error exits 2 with the usage,
	// the convention Go's own tools follow.
	apiFlag := flag.String("api", "", "API base URL; overrides $TODO_API_URL and the "+config.DefaultAPIURL+" default")
	debugLogFlag := flag.String("debug-log", "", "path to the debug log; overrides $TODO_LOG and the XDG state default")
	flag.Parse()

	// The TUI resolves the two settings it needs, each with its own flag on
	// top of the shared precedence rule. It deliberately does not call
	// config.Load: the database path is not the TUI's to resolve, and
	// requiring HOME for a database the TUI never opens would be a promise
	// the binary does not keep.
	apiURL := config.APIURL(os.Getenv, *apiFlag)
	logPath, err := config.LogPath(os.Getenv, *debugLogFlag)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}

	// The logger is the file-only one, and it is built before the program
	// starts: a failure here is printed on the still-normal terminal, and a
	// logger built afterwards could miss the records of the very startup
	// that failed. The level is debug — the file is the TUI's only
	// diagnostic surface, and there is no second run of the session being
	// debugged.
	logger, closer, err := logging.NewFile(logPath, slog.LevelDebug)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer func() {
		// The process is leaving; a close error cannot change the exit code
		// and has nowhere better to go, so it is discarded explicitly, like
		// the CLI's.
		_ = closer.Close()
	}()

	// The resolved paths are the first debug record, the CLI's own
	// "why is my data not where I thought" answer, on the TUI's side of the
	// pair. The release stamp rides along: the TUI's only diagnostic surface
	// is this file, and which build wrote it is the first question a bug
	// report asks.
	logger.Debug("config resolved", "api", apiURL, "log", logPath, "version", version.Version)

	c := client.New(apiURL)

	// q and ctrl+c both leave through tea.Quit, and Run returns nil. A
	// SIGINT that reaches the process outside the raw terminal — input is
	// not a TTY — arrives as ErrInterrupted, which is the same request to
	// stop, not a failure. Everything else — a recovered panic, a renderer
	// error — is an error, and the one line and the exit code are the
	// report. Bubble Tea restores the terminal before Run returns it, so
	// this line lands on a usable terminal, and the record lands in the file
	// the session was already writing to.
	if _, err := tui.NewProgram(tui.New(ctx, c, tui.WithLogger(logger))).Run(); err != nil && !errors.Is(err, tea.ErrInterrupted) {
		logger.Error("todo-tui exited with an error", "err", err)
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}
````
