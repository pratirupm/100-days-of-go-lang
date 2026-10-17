---
title: "internal/config — the finished app"
sidebar:
  hidden: true
tableOfContents: false
pagefind: false
---


Part of [The finished app (spoilers)](/100-days-of-go-lang/appendices/the-finished-app/).


## `internal/config/config.go`

````go
// Package config resolves the application's runtime configuration: where the
// Turso database lives, where the log file will live, what address the HTTP
// server binds, and what URL the TUI calls. Resolution is a pure function of
// an injected environment lookup and the command line's flag values — --db
// for the CLI, --listen for the server, --api for the TUI — so every
// precedence case is a table test and nothing here touches os.Getenv or the
// filesystem itself.
package config

import (
	"fmt"
	"path/filepath"
)

// Config is the resolved runtime configuration.
type Config struct {
	// DBPath is where the Turso database lives.
	DBPath string
	// LogPath is where the log file will live. Nothing writes it yet: the
	// slog setup in chapter 29 consumes it.
	LogPath string
	// Listen is the HTTP server's bind address. The CLI never reads it; the
	// server binary resolves its --listen flag on top with Listen.
	Listen string
	// OTelEndpoint is the OTLP HTTP endpoint traces are exported to. Empty
	// means export is off: spans still carry trace ids — the logs and the
	// traces stay joined — but nothing leaves the process. There is no
	// default: a collector on localhost is an assumption, and a wrong one
	// costs a failed export per batch in the log.
	OTelEndpoint string
	// AdminEmail is the account the boot's admin key seeds or ensures (see
	// internal/auth's BootstrapAdmin). Empty means the key has no account to
	// name, which is an error when a key is set and nothing at all when none
	// is. The key itself is deliberately not a field here: a Config is a
	// value callers may print, and a secret must not be one.
	AdminEmail string
}

// The environment variables the resolution reads, spelled once. An empty
// value means "not set": os.Getenv cannot tell unset from set-to-empty, and
// treating both as absent is the convention the flag follows too.
const (
	envDB         = "TODO_DB"
	envLog        = "TODO_LOG"
	envListen     = "TODO_LISTEN"
	envAPI        = "TODO_API_URL"
	envOTel       = "TODO_OTEL_ENDPOINT"
	envAdminEmail = "TODO_ADMIN_EMAIL"
)

// The environment variables the admin bootstrap's secret arrives through.
// They are exported because main hands the two names to internal/secret,
// which reads the value and returns a type that cannot be printed; the value
// itself never enters a Config, for the reason the AdminEmail field's comment
// gives. The pair is the choice the loader refuses to guess between.
const (
	// EnvAdminKey names the variable holding the bootstrap key itself.
	EnvAdminKey = "TODO_ADMIN_KEY"
	// EnvAdminKeyFile names the variable holding a path to a file that
	// holds the key.
	EnvAdminKeyFile = "TODO_ADMIN_KEY_FILE"
)

// DefaultListen is the address the server binds when neither the flag nor
// the environment says otherwise. Loopback: a freshly started server is
// reachable by its owner, not by the network, until the owner says so.
const DefaultListen = "127.0.0.1:8080"

// DefaultAPIURL is the API base URL the TUI calls when neither its --api
// flag nor $TODO_API_URL says otherwise. It is DefaultListen as a URL: the
// address the server binds by default is the one a freshly started client
// can reach, and it is loopback for the same reason.
const DefaultAPIURL = "http://127.0.0.1:8080"

// The XDG base-directory variables the defaults fall back through. DATA
// holds the database because it is user data; STATE holds the logs because
// they are state that survives between runs. CONFIG is deliberately not
// consulted: chapter 26 has no config file, and inventing an empty one would
// be a promise the chapter does not keep.
const (
	xdgDataHome  = "XDG_DATA_HOME"
	xdgStateHome = "XDG_STATE_HOME"
)

// Load resolves the configuration with the precedence flags > environment >
// XDG defaults:
//
//   - DBPath: a non-empty dbFlag, else $TODO_DB, else
//     $XDG_DATA_HOME/todo/todo.db, else $HOME/.local/share/todo/todo.db;
//   - LogPath: $TODO_LOG, else $XDG_STATE_HOME/todo/logs/todo.log, else
//     $HOME/.local/state/todo/logs/todo.log;
//   - Listen: $TODO_LISTEN, else 127.0.0.1:8080; the server's --listen flag
//     is applied on top by Listen;
//   - OTelEndpoint: $TODO_OTEL_ENDPOINT, else empty — export off;
//   - AdminEmail: $TODO_ADMIN_EMAIL, else empty — no bootstrap account is
//     named, and the admin key must not be set.
//
// getenv is the environment seam: production passes os.Getenv and tests pass
// a map lookup, so no case needs the process environment. A default that
// needs HOME — because no XDG variable and no environment override supplied
// the path — is an error rather than a half-built relative path.
func Load(getenv func(string) string, dbFlag string) (Config, error) {
	dbPath := dbFlag
	if dbPath == "" {
		dbPath = getenv(envDB)
	}
	if dbPath == "" {
		var err error
		dbPath, err = xdgDefault(getenv, xdgDataHome, filepath.Join(".local", "share"), filepath.Join("todo", "todo.db"))
		if err != nil {
			return Config{}, fmt.Errorf("config: database path: %w", err)
		}
	}

	logPath, err := LogPath(getenv, "")
	if err != nil {
		return Config{}, fmt.Errorf("config: log path: %w", err)
	}

	return Config{
		DBPath:       dbPath,
		LogPath:      logPath,
		Listen:       Listen(getenv, ""),
		OTelEndpoint: getenv(envOTel),
		AdminEmail:   getenv(envAdminEmail),
	}, nil
}

// Listen resolves the HTTP server's listen address: a non-empty flag beats
// $TODO_LISTEN, which beats DefaultListen. Load resolves the same rule for
// the configuration it returns; the server binary calls Listen itself with
// its --listen flag, which Load cannot see. An empty flag and an empty
// environment value both mean "not set", the convention every other setting
// follows.
func Listen(getenv func(string) string, flag string) string {
	if flag != "" {
		return flag
	}
	if listen := getenv(envListen); listen != "" {
		return listen
	}
	return DefaultListen
}

// APIURL resolves the TUI's API base URL: a non-empty flag beats
// $TODO_API_URL, which beats DefaultAPIURL. The TUI binary calls it with its
// --api flag, which Load cannot see — the same split Listen has, on the
// client side of the same pair — and the rule is Listen's deliberately: two
// binaries, two settings, one precedence story. The TUI resolves this one
// setting and not Load: the database path and the log path are not the TUI's
// to resolve, and requiring HOME for a database the TUI never opens would be
// a promise the binary does not keep.
func APIURL(getenv func(string) string, flag string) string {
	if flag != "" {
		return flag
	}
	if url := getenv(envAPI); url != "" {
		return url
	}
	return DefaultAPIURL
}

// LogPath resolves the log file's path: a non-empty flag beats $TODO_LOG,
// which beats $XDG_STATE_HOME/todo/logs/todo.log, else
// $HOME/.local/state/todo/logs/todo.log. Load resolves the same rule with no
// flag; the TUI resolves it with its --debug-log flag, the same split Listen
// and APIURL have for their settings. It is deliberately the whole of what
// the TUI needs from Load: the TUI writes no log until this chapter, and now
// that it does, the setting is resolved on its own — the database path and
// the rest of Load stay the CLI's, so requiring HOME for a database the TUI
// never opens is not part of starting the TUI.
//
// The path's parent may not exist; making it exist is the logger's job, not
// this function's — resolution stays pure.
func LogPath(getenv func(string) string, flag string) (string, error) {
	if flag != "" {
		return flag, nil
	}
	if logPath := getenv(envLog); logPath != "" {
		return logPath, nil
	}
	return xdgDefault(getenv, xdgStateHome, filepath.Join(".local", "state"), filepath.Join("todo", "logs", "todo.log"))
}

// xdgDefault resolves one file below an XDG base directory: $name joined
// with fileRel when the environment sets it to an absolute path,
// $HOME/homeRel/fileRel otherwise. A relative $name is invalid per the XDG
// spec and is ignored like an unset variable; the error names what was
// missing so a bare environment fails with a reason, not with a path rooted
// in the working directory.
func xdgDefault(getenv func(string) string, name, homeRel, fileRel string) (string, error) {
	if base := getenv(name); base != "" && filepath.IsAbs(base) {
		return filepath.Join(base, fileRel), nil
	}
	home := getenv("HOME")
	if home == "" {
		return "", fmt.Errorf("neither $%s nor $HOME names an absolute directory", name)
	}
	return filepath.Join(home, homeRel, fileRel), nil
}
````


## `internal/config/config_test.go`

````go
package config_test

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/config"
)

// getenvFrom adapts a map to the getenv seam Load takes. Production passes
// os.Getenv; the tests pass this, so every case is a plain map — no process
// environment is read or written, and the cases can run in parallel.
func getenvFrom(env map[string]string) func(string) string {
	return func(key string) string { return env[key] }
}

// TestLoad is the precedence truth table: flags > environment > XDG defaults,
// with the defaults themselves pinned against an injected HOME and injected
// XDG variables. Each case is one row, and the injected getenv is the whole
// mechanism — nothing here depends on the machine's environment. The server
// flag is not one of Load's inputs; TestListen pins the flag's precedence on
// top of the rule Load applies here.
func TestLoad(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		env    map[string]string
		dbFlag string
		want   config.Config
	}{
		{
			name: "the defaults follow HOME when no XDG variable is set",
			env:  map[string]string{"HOME": "/home/user"},
			want: config.Config{
				DBPath:  "/home/user/.local/share/todo/todo.db",
				LogPath: "/home/user/.local/state/todo/logs/todo.log",
				Listen:  config.DefaultListen,
			},
		},
		{
			name: "XDG_DATA_HOME and XDG_STATE_HOME replace the HOME fallback",
			env: map[string]string{
				"HOME":           "/home/user",
				"XDG_DATA_HOME":  "/xdg/data",
				"XDG_STATE_HOME": "/xdg/state",
			},
			want: config.Config{
				DBPath:  "/xdg/data/todo/todo.db",
				LogPath: "/xdg/state/todo/logs/todo.log",
				Listen:  config.DefaultListen,
			},
		},
		{
			name: "the two XDG variables are independent",
			env: map[string]string{
				"HOME":           "/home/user",
				"XDG_STATE_HOME": "/xdg/state",
			},
			want: config.Config{
				DBPath:  "/home/user/.local/share/todo/todo.db",
				LogPath: "/xdg/state/todo/logs/todo.log",
				Listen:  config.DefaultListen,
			},
		},
		{
			name: "TODO_DB and TODO_LOG override the defaults",
			env: map[string]string{
				"HOME":     "/home/user",
				"TODO_DB":  "/tmp/env.db",
				"TODO_LOG": "/tmp/env.log",
			},
			want: config.Config{
				DBPath:  "/tmp/env.db",
				LogPath: "/tmp/env.log",
				Listen:  config.DefaultListen,
			},
		},
		{
			name: "TODO_LISTEN overrides the default",
			env: map[string]string{
				"HOME":        "/home/user",
				"TODO_LISTEN": "0.0.0.0:9090",
			},
			want: config.Config{
				DBPath:  "/home/user/.local/share/todo/todo.db",
				LogPath: "/home/user/.local/state/todo/logs/todo.log",
				Listen:  "0.0.0.0:9090",
			},
		},
		{
			name: "TODO_OTEL_ENDPOINT turns trace export on",
			env: map[string]string{
				"HOME":               "/home/user",
				"TODO_OTEL_ENDPOINT": "http://127.0.0.1:4318",
			},
			want: config.Config{
				DBPath:       "/home/user/.local/share/todo/todo.db",
				LogPath:      "/home/user/.local/state/todo/logs/todo.log",
				Listen:       config.DefaultListen,
				OTelEndpoint: "http://127.0.0.1:4318",
			},
		},
		{
			name: "TODO_ADMIN_EMAIL names the bootstrap account",
			env: map[string]string{
				"HOME":             "/home/user",
				"TODO_ADMIN_EMAIL": "admin@example.com",
			},
			want: config.Config{
				DBPath:     "/home/user/.local/share/todo/todo.db",
				LogPath:    "/home/user/.local/state/todo/logs/todo.log",
				Listen:     config.DefaultListen,
				AdminEmail: "admin@example.com",
			},
		},
		{
			name: "an empty TODO_LISTEN falls through to the default",
			env: map[string]string{
				"HOME":        "/home/user",
				"TODO_LISTEN": "",
			},
			want: config.Config{
				DBPath:  "/home/user/.local/share/todo/todo.db",
				LogPath: "/home/user/.local/state/todo/logs/todo.log",
				Listen:  config.DefaultListen,
			},
		},
		{
			name: "the environment can cover every setting without HOME",
			env: map[string]string{
				"TODO_DB":     "/tmp/env.db",
				"TODO_LOG":    "/tmp/env.log",
				"TODO_LISTEN": "127.0.0.1:9090",
			},
			want: config.Config{
				DBPath:  "/tmp/env.db",
				LogPath: "/tmp/env.log",
				Listen:  "127.0.0.1:9090",
			},
		},
		{
			name: "a non-empty flag beats TODO_DB",
			env: map[string]string{
				"HOME":    "/home/user",
				"TODO_DB": "/tmp/env.db",
			},
			dbFlag: "/tmp/flag.db",
			want: config.Config{
				DBPath:  "/tmp/flag.db",
				LogPath: "/home/user/.local/state/todo/logs/todo.log",
				Listen:  config.DefaultListen,
			},
		},
		{
			name:   "an empty flag falls through to TODO_DB",
			env:    map[string]string{"HOME": "/home/user", "TODO_DB": "/tmp/env.db"},
			dbFlag: "",
			want: config.Config{
				DBPath:  "/tmp/env.db",
				LogPath: "/home/user/.local/state/todo/logs/todo.log",
				Listen:  config.DefaultListen,
			},
		},
		{
			name:   "an empty flag falls through to the default",
			env:    map[string]string{"HOME": "/home/user", "TODO_DB": ""},
			dbFlag: "",
			want: config.Config{
				DBPath:  "/home/user/.local/share/todo/todo.db",
				LogPath: "/home/user/.local/state/todo/logs/todo.log",
				Listen:  config.DefaultListen,
			},
		},
		{
			name:   "the flag's path is used verbatim",
			env:    map[string]string{"HOME": "/home/user"},
			dbFlag: "data/todo.db",
			want: config.Config{
				DBPath:  "data/todo.db",
				LogPath: "/home/user/.local/state/todo/logs/todo.log",
				Listen:  config.DefaultListen,
			},
		},
		{
			name: "a relative XDG_DATA_HOME is ignored, as the spec says",
			env: map[string]string{
				"HOME":          "/home/user",
				"XDG_DATA_HOME": "relative/data",
			},
			want: config.Config{
				DBPath:  "/home/user/.local/share/todo/todo.db",
				LogPath: "/home/user/.local/state/todo/logs/todo.log",
				Listen:  config.DefaultListen,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got, err := config.Load(getenvFrom(tt.env), tt.dbFlag)
			require.NoError(t, err)
			assert.Equal(t, tt.want, got)
		})
	}
}

// TestListen is the listen address's precedence table: the server's flag
// beats $TODO_LISTEN, which beats the loopback default. Load applies the
// same rule with no flag, so the environment and default rows appear in both
// tables — this one owns the flag.
func TestListen(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		env  map[string]string
		flag string
		want string
	}{
		{
			name: "nothing set gets the loopback default",
			want: config.DefaultListen,
		},
		{
			name: "TODO_LISTEN beats the default",
			env:  map[string]string{"TODO_LISTEN": "0.0.0.0:9090"},
			want: "0.0.0.0:9090",
		},
		{
			name: "a non-empty flag beats TODO_LISTEN",
			env:  map[string]string{"TODO_LISTEN": "0.0.0.0:9090"},
			flag: "127.0.0.1:8081",
			want: "127.0.0.1:8081",
		},
		{
			name: "an empty flag falls through to TODO_LISTEN",
			env:  map[string]string{"TODO_LISTEN": "0.0.0.0:9090"},
			flag: "",
			want: "0.0.0.0:9090",
		},
		{
			name: "an empty TODO_LISTEN falls through to the default",
			env:  map[string]string{"TODO_LISTEN": ""},
			want: config.DefaultListen,
		},
		{
			name: "the flag's address is used verbatim",
			flag: ":0",
			want: ":0",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			assert.Equal(t, tt.want, config.Listen(getenvFrom(tt.env), tt.flag))
		})
	}
}

// TestAPIURL is the API base URL's precedence table: the TUI's flag beats
// $TODO_API_URL, which beats the loopback default. The client side of the
// pair TestListen owns — the server binds the address, the TUI calls it —
// with the same rule and the same three sources.
func TestAPIURL(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		env  map[string]string
		flag string
		want string
	}{
		{
			name: "nothing set gets the loopback default",
			want: config.DefaultAPIURL,
		},
		{
			name: "TODO_API_URL beats the default",
			env:  map[string]string{"TODO_API_URL": "https://todo.example.com"},
			want: "https://todo.example.com",
		},
		{
			name: "a non-empty flag beats TODO_API_URL",
			env:  map[string]string{"TODO_API_URL": "https://todo.example.com"},
			flag: "http://127.0.0.1:9090",
			want: "http://127.0.0.1:9090",
		},
		{
			name: "an empty flag falls through to TODO_API_URL",
			env:  map[string]string{"TODO_API_URL": "https://todo.example.com"},
			flag: "",
			want: "https://todo.example.com",
		},
		{
			name: "an empty TODO_API_URL falls through to the default",
			env:  map[string]string{"TODO_API_URL": ""},
			want: config.DefaultAPIURL,
		},
		{
			name: "the flag's URL is used verbatim",
			flag: "http://localhost:8081/api",
			want: "http://localhost:8081/api",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			assert.Equal(t, tt.want, config.APIURL(getenvFrom(tt.env), tt.flag))
		})
	}
}

// TestLogPath is the log path's precedence table: the TUI's --debug-log flag
// beats $TODO_LOG, which beats $XDG_STATE_HOME/todo/logs/todo.log, which
// falls back to HOME. Load applies the same rule with no flag — the
// environment and default rows are shared with TestLoad — and this table
// owns the flag, the same split TestListen and TestAPIURL have for their
// settings. The last row owns the error: a default that needs HOME and finds
// neither HOME nor an XDG variable fails instead of returning a relative
// path.
func TestLogPath(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		env  map[string]string
		flag string
		want string
	}{
		{
			name: "nothing set follows HOME",
			env:  map[string]string{"HOME": "/home/user"},
			want: "/home/user/.local/state/todo/logs/todo.log",
		},
		{
			name: "XDG_STATE_HOME replaces the HOME fallback",
			env:  map[string]string{"HOME": "/home/user", "XDG_STATE_HOME": "/xdg/state"},
			want: "/xdg/state/todo/logs/todo.log",
		},
		{
			name: "TODO_LOG beats the default",
			env:  map[string]string{"HOME": "/home/user", "TODO_LOG": "/tmp/env.log"},
			want: "/tmp/env.log",
		},
		{
			name: "a non-empty flag beats TODO_LOG",
			env:  map[string]string{"HOME": "/home/user", "TODO_LOG": "/tmp/env.log"},
			flag: "/tmp/flag.log",
			want: "/tmp/flag.log",
		},
		{
			name: "an empty flag falls through to TODO_LOG",
			env:  map[string]string{"HOME": "/home/user", "TODO_LOG": "/tmp/env.log"},
			want: "/tmp/env.log",
		},
		{
			name: "an empty TODO_LOG falls through to the default",
			env:  map[string]string{"HOME": "/home/user", "TODO_LOG": ""},
			want: "/home/user/.local/state/todo/logs/todo.log",
		},
		{
			name: "the flag's path is used verbatim",
			flag: "logs/tui.log",
			want: "logs/tui.log",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got, err := config.LogPath(getenvFrom(tt.env), tt.flag)
			require.NoError(t, err)
			assert.Equal(t, tt.want, got)
		})
	}

	t.Run("no HOME and no XDG variable is an error", func(t *testing.T) {
		t.Parallel()

		got, err := config.LogPath(getenvFrom(nil), "")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "HOME")
		assert.Empty(t, got)
	})
}

// TestLoad_NoHome pins the error path: a default that needs HOME and finds
// neither HOME nor an XDG variable is an error, not a half-built relative
// path, and no partial config comes back.
func TestLoad_NoHome(t *testing.T) {
	t.Parallel()

	got, err := config.Load(getenvFrom(nil), "")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "HOME")
	assert.Empty(t, got)
}
````
