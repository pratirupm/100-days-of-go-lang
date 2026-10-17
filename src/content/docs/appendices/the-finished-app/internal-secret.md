---
title: "internal/secret — the finished app"
description: "The finished app, file by file: internal/secret (spoilers)."
sidebar:
  hidden: true
tableOfContents: false
pagefind: false
---


Part of [The finished app (spoilers)](/100-days-of-go-lang/appendices/the-finished-app/).


## `internal/secret/load.go`

````go
package secret

import (
	"fmt"
	"os"
	"strings"
)

// maxSecretLen bounds what Load reads out of a file: 4 KiB is orders of
// magnitude more than a key, and small enough that a path pointing at the
// wrong file cannot turn a boot into a read of a log or a disk image.
const maxSecretLen = 4096

// Load resolves a secret from the environment: the variable named by
// directEnv holds the value itself, or the variable named by fileEnv holds a
// path to a file that does. Setting both is an error rather than a
// precedence: one credential with two sources is an ambiguity an operator has
// to resolve, not a default the loader should guess. Neither set is not an
// error — the secret is empty — because a deployment without the credential
// is a legitimate one.
//
// The direct value is taken verbatim: an environment variable is exact, and
// spaces or punctuation in a key are the key. The file is read with the
// checks this process can make: a regular file, at most maxSecretLen bytes,
// and owner-only — group and other bits are refused, because a credential
// file another account can read is a credential another account holds. The
// mode bits are the check's whole substance: ownership is not verified (the
// process cannot know which account the operator meant) and a symlink is
// followed like any other read. Trailing newlines are trimmed: a file is
// written by an editor or a shell redirect, and the newline belongs to the
// editor, not to the key.
//
// getenv is the environment seam, the chapter 26 pattern: production passes
// os.Getenv, tests pass a map. The file is real either way — its mode bits
// are what the check reads, and a check against a fake file system would not
// be the check that runs in production.
func Load(getenv func(string) string, directEnv, fileEnv string) (Secret, error) {
	direct := getenv(directEnv)
	path := getenv(fileEnv)
	if direct != "" && path != "" {
		return "", fmt.Errorf("secret: set either %s or %s, not both", directEnv, fileEnv)
	}
	if direct != "" {
		return Secret(direct), nil
	}
	if path == "" {
		return "", nil
	}

	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("secret: %s: %w", fileEnv, err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("secret: %s: %s is not a regular file", fileEnv, path)
	}
	if perm := info.Mode().Perm(); perm&0o077 != 0 {
		return "", fmt.Errorf("secret: %s: %s is mode %04o; a credential file must not be readable by group or other", fileEnv, path, perm)
	}
	if info.Size() > maxSecretLen {
		return "", fmt.Errorf("secret: %s: %s is %d bytes; a credential is at most %d", fileEnv, path, info.Size(), maxSecretLen)
	}

	data, err := os.ReadFile(path) // #nosec G304 -- the path is the operator's configured credential location, not caller input
	if err != nil {
		return "", fmt.Errorf("secret: %s: %w", fileEnv, err)
	}
	value := strings.TrimRight(string(data), "\r\n")
	if value == "" {
		return "", fmt.Errorf("secret: %s: %s is empty", fileEnv, path)
	}
	return Secret(value), nil
}
````


## `internal/secret/load_test.go`

````go
package secret_test

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/secret"
)

// The variable names the loader cases use. They are not the application's —
// Load takes the names as arguments, which is what lets a test spell its own
// — but they follow the application's naming so the shape stays familiar.
const (
	directVar = "TODO_TEST_KEY"
	fileVar   = "TODO_TEST_KEY_FILE"
)

// getenvFrom adapts a map to the getenv seam Load takes: production passes
// os.Getenv, the tests pass this, so no case reads or writes the process
// environment and the cases can run in parallel.
func getenvFrom(env map[string]string) func(string) string {
	return func(key string) string { return env[key] }
}

// writeKeyFile writes a key file with the given mode. The chmod is explicit:
// os.WriteFile's mode is masked by the umask, so the mode a case names must
// be the mode on disk — the check under test reads the disk's bits.
func writeKeyFile(t *testing.T, mode os.FileMode, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "admin-key")
	require.NoError(t, os.WriteFile(path, []byte(content), mode)) // #nosec G306 -- the mode is the case under test
	require.NoError(t, os.Chmod(path, mode))
	return path
}

// TestLoad_Env pins the direct variable: verbatim, empty-is-unset, and the
// two-source refusal.
func TestLoad_Env(t *testing.T) {
	t.Parallel()

	t.Run("neither source is set: the empty secret, no error", func(t *testing.T) {
		t.Parallel()

		key, err := secret.Load(getenvFrom(nil), directVar, fileVar)
		require.NoError(t, err)
		assert.True(t, key.IsEmpty())
	})

	t.Run("the variable is the key, verbatim", func(t *testing.T) {
		t.Parallel()

		key, err := secret.Load(getenvFrom(map[string]string{directVar: "  a key with spaces  "}), directVar, fileVar)
		require.NoError(t, err)
		assert.Equal(t, "  a key with spaces  ", key.Reveal(), "the environment's value is exact: no trimming")
	})

	t.Run("an empty variable is not set", func(t *testing.T) {
		t.Parallel()

		key, err := secret.Load(getenvFrom(map[string]string{directVar: ""}), directVar, fileVar)
		require.NoError(t, err)
		assert.True(t, key.IsEmpty())
	})

	t.Run("both sources set is an error", func(t *testing.T) {
		t.Parallel()

		_, err := secret.Load(getenvFrom(map[string]string{
			directVar: "from-the-environment",
			fileVar:   "/run/credentials/todo/admin-key",
		}), directVar, fileVar)
		require.Error(t, err)
		assert.Contains(t, err.Error(), directVar, "the error names the two variables")
		assert.Contains(t, err.Error(), fileVar)
	})
}

// TestLoad_File pins the file variant: the content is the key with the
// trailing newline trimmed, the mode must be owner-only, and every way the
// file can be wrong is refused by name — never by echoing the key.
func TestLoad_File(t *testing.T) {
	t.Parallel()

	t.Run("a 0600 file is the key, newline trimmed", func(t *testing.T) {
		t.Parallel()

		path := writeKeyFile(t, 0o600, "todo-admin-key-from-a-file\n")
		key, err := secret.Load(getenvFrom(map[string]string{fileVar: path}), directVar, fileVar)
		require.NoError(t, err)
		assert.Equal(t, "todo-admin-key-from-a-file", key.Reveal())
	})

	t.Run("a 0400 file is accepted", func(t *testing.T) {
		t.Parallel()

		path := writeKeyFile(t, 0o400, "read-only-key")
		key, err := secret.Load(getenvFrom(map[string]string{fileVar: path}), directVar, fileVar)
		require.NoError(t, err)
		assert.Equal(t, "read-only-key", key.Reveal())
	})

	t.Run("an empty direct variable lets the file answer", func(t *testing.T) {
		t.Parallel()

		path := writeKeyFile(t, 0o600, "from-the-file")
		key, err := secret.Load(getenvFrom(map[string]string{fileVar: path, directVar: ""}), directVar, fileVar)
		require.NoError(t, err)
		assert.Equal(t, "from-the-file", key.Reveal())
	})

	for _, mode := range []os.FileMode{0o640, 0o644, 0o604} {
		t.Run(fmt.Sprintf("a %04o file is refused", mode), func(t *testing.T) {
			t.Parallel()

			path := writeKeyFile(t, mode, "todo-admin-key-from-a-file")
			_, err := secret.Load(getenvFrom(map[string]string{fileVar: path}), directVar, fileVar)
			require.Error(t, err)
			assert.Contains(t, err.Error(), fmt.Sprintf("%04o", mode), "the refusal names the mode it found")
			assert.NotContains(t, err.Error(), "todo-admin-key-from-a-file", "the refusal does not echo the key")
		})
	}

	t.Run("a missing file is an error", func(t *testing.T) {
		t.Parallel()

		_, err := secret.Load(getenvFrom(map[string]string{fileVar: filepath.Join(t.TempDir(), "absent")}), directVar, fileVar)
		require.Error(t, err)
	})

	t.Run("an empty file is an error", func(t *testing.T) {
		t.Parallel()

		path := writeKeyFile(t, 0o600, "\n")
		_, err := secret.Load(getenvFrom(map[string]string{fileVar: path}), directVar, fileVar)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "empty")
	})

	t.Run("a directory is refused", func(t *testing.T) {
		t.Parallel()

		_, err := secret.Load(getenvFrom(map[string]string{fileVar: t.TempDir()}), directVar, fileVar)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "regular file")
	})

	t.Run("a file larger than a credential is refused", func(t *testing.T) {
		t.Parallel()

		path := writeKeyFile(t, 0o600, strings.Repeat("k", 5000))
		_, err := secret.Load(getenvFrom(map[string]string{fileVar: path}), directVar, fileVar)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "5000")
	})
}
````


## `internal/secret/secret.go`

````go
// Package secret carries credentials through the process without letting
// them reach a log record, a formatted string, or a JSON document.
//
// A Secret is a string underneath, and the type is the whole mechanism: it
// implements Stringer, GoStringer, slog.LogValuer, and encoding.TextMarshaler,
// so every printing path the standard library and slog offer — the fmt verbs,
// a struct field, a record attribute, a marshaled document — shows a fixed
// redaction instead of the value. Reveal is the one method that returns the
// secret itself, which makes `grep -rn 'Reveal()'` the audit of every place a
// credential becomes a string.
//
// The type closes the accidental paths, not every path: a caller that Reveals
// and hands the string to a map, a template, or a driver has left the type
// behind, and that is a decision it should have to make explicitly.
//
// Loading lives beside the type (see Load): the environment variable and the
// owner-only file are the two sources this process can verify, and the
// deployment's third — systemd's LoadCredential — arrives as the same file
// with the same check.
package secret

import "log/slog"

// redacted is what every printing path shows in place of the value. One
// spelling, so a search for it in a log file answers "did this record carry a
// secret?" with one pattern.
const redacted = "[REDACTED]"

// Secret is a credential in memory: a string that knows how not to print.
type Secret string

// String returns the redaction. It is the fmt verbs' path — %v, %s, %q — and
// fmt calls it for a struct field too, so printing a configuration value that
// holds a Secret redacts the field rather than the whole value.
func (s Secret) String() string { return redacted }

// GoString returns the redaction in Go syntax: %#v's path. Without it, %#v
// would print the underlying string, because %#v consults GoStringer before
// Stringer.
func (s Secret) GoString() string { return `secret.Secret("` + redacted + `")` }

// LogValue returns the redaction as a slog value: a record attribute that
// holds a Secret shows the redaction, whichever handler renders it. slog
// resolves a LogValuer before any handler sees the value, so the JSON sink,
// the file sink, and tint are all covered by this one method.
func (s Secret) LogValue() slog.Value { return slog.StringValue(redacted) }

// MarshalText returns the redaction: encoding/json and every other
// TextMarshaler consumer print it in place of the value, so a Secret in a
// marshaled document is redacted there too.
func (s Secret) MarshalText() ([]byte, error) { return []byte(redacted), nil }

// Reveal returns the secret itself. It is the one way out of the type, and
// every call site is a deliberate boundary: the hash, the comparison, the
// reader that needs the bytes.
func (s Secret) Reveal() string { return string(s) }

// IsEmpty reports whether the secret holds nothing: the unset variable, the
// absent file. The empty secret is how "no credential configured" travels —
// the same convention the configuration's empty values follow.
func (s Secret) IsEmpty() bool { return s == "" }
````


## `internal/secret/secret_test.go`

````go
// Package secret_test pins the redaction contract: a credential carried as a
// secret.Secret reaches no log record, no formatted string, and no JSON
// document, and Reveal is the one way out. Chapter 29's preview promised this
// type; these cases are where the promise becomes an assertion.
package secret_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/logging"
	"todo/internal/secret"
)

// testKey is what every case tries to find in the output. Nothing parses it;
// it only has to be a value a reader would recognize if it leaked.
const testKey = "todo-admin-key-4f3c1d2b-never-logged"

// TestSecret_Redacts drives every path a value can take to a string: the fmt
// verbs, a struct that holds it, a slog record, and JSON. A failure here is
// the leak itself: the key appears in the assertion's message.
func TestSecret_Redacts(t *testing.T) {
	t.Parallel()

	key := secret.Secret(testKey)

	t.Run("the fmt verbs redact", func(t *testing.T) {
		t.Parallel()

		// The verbs in a table, not in four literal calls: the point is the
		// set of paths, and a new path is a new row.
		for _, verb := range []string{"%v", "%s", "%q", "%#v"} {
			got := fmt.Sprintf(verb, key)
			assert.NotContains(t, got, testKey, "%s leaked the key", verb)
			assert.Contains(t, got, "REDACTED", "%s shows the redaction", verb)
		}
		assert.NotContains(t, key.String(), testKey)
	})

	t.Run("a struct that holds it redacts", func(t *testing.T) {
		t.Parallel()

		cfg := struct {
			AdminEmail string
			AdminKey   secret.Secret
		}{AdminEmail: "admin@example.com", AdminKey: key}

		for _, verb := range []string{"%v", "%+v"} {
			got := fmt.Sprintf(verb, cfg)
			assert.NotContains(t, got, testKey, "%s leaked the key through the struct", verb)
			assert.Contains(t, got, "REDACTED")
		}
	})

	t.Run("a slog record redacts", func(t *testing.T) {
		t.Parallel()

		var buf bytes.Buffer
		logger := slog.New(slog.NewJSONHandler(&buf, nil))
		logger.Info("bootstrap", "key", key, "config", struct{ Key secret.Secret }{key})

		assert.NotContains(t, buf.String(), testKey)
		assert.Contains(t, buf.String(), "REDACTED")
	})

	t.Run("JSON redacts", func(t *testing.T) {
		t.Parallel()

		data, err := json.Marshal(struct {
			Key secret.Secret `json:"key"`
		}{key})
		require.NoError(t, err)
		assert.NotContains(t, string(data), testKey)
		assert.Contains(t, string(data), "REDACTED")
	})

	t.Run("Reveal is the one way out", func(t *testing.T) {
		t.Parallel()

		assert.Equal(t, testKey, key.Reveal())
	})
}

// TestSecret_ProcessLogger is the redaction against the real thing: the
// process logger the server boots with — both sinks, the pipe's JSON and the
// file's — carries a record about a secret, and the secret is in neither.
func TestSecret_ProcessLogger(t *testing.T) {
	t.Parallel()

	var stderr bytes.Buffer
	logPath := filepath.Join(t.TempDir(), "todo.log")
	logger, closer, err := logging.New(&stderr, false, logPath, slog.LevelInfo)
	require.NoError(t, err)
	t.Cleanup(func() { _ = closer.Close() })

	logger.Info("admin credential ensured", "email", "admin@example.com", "key", secret.Secret(testKey))

	file, err := os.ReadFile(logPath) // #nosec G304 -- logPath is built by this test from t.TempDir
	require.NoError(t, err)

	// The captured lines are logged, so a chapter transcript can show the
	// record both sinks hold — redacted — instead of describing it.
	t.Logf("stderr: %s", strings.TrimSpace(stderr.String()))
	t.Logf("file:   %s", strings.TrimSpace(string(file)))

	for _, sink := range []struct {
		name string
		data string
	}{
		{"stderr", stderr.String()},
		{"the log file", string(file)},
	} {
		assert.Contains(t, sink.data, `"msg":"admin credential ensured"`, "%s kept the record", sink.name)
		assert.NotContains(t, sink.data, testKey, "%s leaked the key", sink.name)
		assert.Contains(t, sink.data, "REDACTED", "%s shows the redaction", sink.name)
	}
}

// TestSecret_Empty pins the zero value: an unset secret is empty, prints as
// the redaction, and reveals as nothing.
func TestSecret_Empty(t *testing.T) {
	t.Parallel()

	var unset secret.Secret
	assert.True(t, unset.IsEmpty())
	assert.False(t, secret.Secret("x").IsEmpty())
	assert.Equal(t, "", unset.Reveal())
	assert.NotContains(t, unset.String(), testKey)
}
````
