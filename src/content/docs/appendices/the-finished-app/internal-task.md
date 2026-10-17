---
title: "internal/task — the finished app"
description: "The finished app, file by file: internal/task (spoilers)."
sidebar:
  hidden: true
tableOfContents: false
pagefind: false
---


Part of [The finished app (spoilers)](/100-days-of-go-lang/appendices/the-finished-app/).


## `internal/task/__snapshots__/task_test.snap`

````text

[TestTask_String_Snapshots/default_task - 1]
[Todo] buy milk
---

[TestTask_String_Snapshots/task_with_a_due_date - 1]
[Todo] buy milk (due 2026-10-20)
---

[TestTask_String_Snapshots/done_task - 1]
[Done] buy milk
---

[TestTask_String_Snapshots/done_task_with_a_due_date - 1]
[Done] buy milk (due 2026-10-20)
---
````


## `internal/task/task.go`

````go
// Package task defines the todo domain type.
package task

import (
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Task is a single todo item.
type Task struct {
	// ID is the task's identifier. It is uuid.Nil until a store assigns
	// one; stores assign UUIDv7 values, which sort by creation time.
	ID uuid.UUID
	// Version counts the writes the task has seen. A store assigns 1 when
	// it stores the task and bumps it on every write; a caller reads it
	// with the task and hands it back with a write, which the store
	// accepts only while the version still matches. The zero value is
	// "no snapshot yet": stores overwrite it on Add.
	Version int
	// Title is the short description of the work to do.
	Title string
	// Status is the workflow state of the task. Tasks built by NewTask
	// start in StatusTodo.
	Status Status
	// Priority is the task's urgency. Tasks built by NewTask start at
	// PriorityDefault.
	Priority Priority
	// Due is the deadline. The zero value means the task has no due date.
	Due time.Time
	// Tags is the set of labels attached to the task. Tasks built by
	// NewTask start with no tags.
	Tags []string
}

// Status is a task's lifecycle state.
type Status string

const (
	// StatusTodo is the state of a task that still has work left.
	StatusTodo Status = "Todo"
	// StatusDone is the state of a completed task.
	StatusDone Status = "Done"
)

// String returns the status as text, such as "Todo".
func (s Status) String() string {
	return string(s)
}

// MarshalText returns the status in its text form, such as "Todo". The
// method makes Status an encoding.TextMarshaler, which encoding/json honors.
func (s Status) MarshalText() ([]byte, error) {
	return []byte(s), nil
}

// UnmarshalText sets the status from its text form. It accepts only the
// known statuses and reports anything else as a ValidationError.
func (s *Status) UnmarshalText(text []byte) error {
	switch Status(text) {
	case StatusTodo, StatusDone:
		*s = Status(text)
		return nil
	default:
		return ValidationError{Field: "status", Message: fmt.Sprintf("unknown status %q", text)}
	}
}

// Priority is a task's urgency, from 1 (lowest) to 5 (highest).
type Priority int

const (
	// PriorityMin is the lowest urgency.
	PriorityMin Priority = 1
	// PriorityDefault is the urgency NewTask assigns to a new task.
	PriorityDefault Priority = 3
	// PriorityMax is the highest urgency.
	PriorityMax Priority = 5
)

// Valid reports whether the priority is within the allowed range,
// PriorityMin through PriorityMax.
func (p Priority) Valid() bool {
	return p >= PriorityMin && p <= PriorityMax
}

// ValidationError reports a task field that failed validation.
type ValidationError struct {
	// Field is the name of the task field that failed validation, such as
	// "title".
	Field string
	// Message explains why the field is invalid.
	Message string
}

// Error returns the validation failure as a message, such as
// "invalid title: cannot be empty".
func (e ValidationError) Error() string {
	return fmt.Sprintf("invalid %s: %s", e.Field, e.Message)
}

// maxTitleLength is the longest title NewTask accepts.
const maxTitleLength = 200

// NewTask validates the title and returns a task with the default status,
// priority, and no due date. It returns a ValidationError if the title is
// empty after trimming surrounding whitespace or if it is longer than
// maxTitleLength characters.
func NewTask(title string) (Task, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return Task{}, ValidationError{Field: "title", Message: "cannot be empty"}
	}
	if len(title) > maxTitleLength {
		return Task{}, ValidationError{
			Field:   "title",
			Message: fmt.Sprintf("must be at most %d characters", maxTitleLength),
		}
	}
	return Task{
		Title:    title,
		Status:   StatusTodo,
		Priority: PriorityDefault,
	}, nil
}

// ParseDue parses a due date. now is the reference for relative words;
// callers pass time.Now(). Accepted inputs (after trimming spaces and
// lowercasing): "today", "tomorrow", and absolute dates in 2006-01-02 form.
// The result is always at UTC midnight.
func ParseDue(s string, now time.Time) (time.Time, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return time.Time{}, ValidationError{Field: "due", Message: "cannot be empty"}
	}
	if s == "today" {
		return midnightUTC(now), nil
	}
	if s == "tomorrow" {
		return midnightUTC(now).AddDate(0, 0, 1), nil
	}
	due, err := time.Parse("2006-01-02", s)
	if err != nil {
		return time.Time{}, ValidationError{
			Field:   "due",
			Message: fmt.Sprintf("unrecognized date %q", s),
		}
	}
	return due, nil
}

// midnightUTC returns the start of t's date in UTC.
func midnightUTC(t time.Time) time.Time {
	year, month, day := t.UTC().Date()
	return time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
}

// String returns a one-line summary of the task, such as
// "[Todo] buy milk" or "[Todo] buy milk (due 2026-10-20)".
func (t Task) String() string {
	if t.Due.IsZero() {
		return fmt.Sprintf("[%s] %s", t.Status, t.Title)
	}
	return fmt.Sprintf("[%s] %s (due %s)", t.Status, t.Title, t.Due.Format("2006-01-02"))
}
````


## `internal/task/task_test.go`

````go
package task

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/gkampitakis/go-snaps/snaps"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewTask(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		title     string
		wantTitle string
		wantErr   bool
	}{
		{
			name:      "valid title gets defaults",
			title:     "buy milk",
			wantTitle: "buy milk",
		},
		{
			name:      "title is trimmed",
			title:     "  buy milk  ",
			wantTitle: "buy milk",
		},
		{
			name:    "empty title is rejected",
			title:   "",
			wantErr: true,
		},
		{
			name:    "whitespace-only title is rejected",
			title:   " \t ",
			wantErr: true,
		},
		{
			name:      "title at the length limit is accepted",
			title:     strings.Repeat("x", 200),
			wantTitle: strings.Repeat("x", 200),
		},
		{
			name:    "title over the length limit is rejected",
			title:   strings.Repeat("x", 201),
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got, err := NewTask(tt.title)
			if tt.wantErr {
				var ve ValidationError
				require.ErrorAs(t, err, &ve)
				assert.Equal(t, "title", ve.Field)
				return
			}

			require.NoError(t, err)
			assert.Equal(t, tt.wantTitle, got.Title)
			assert.Equal(t, StatusTodo, got.Status)
			assert.Equal(t, PriorityDefault, got.Priority)
			assert.True(t, got.Due.IsZero())
		})
	}
}

func TestTask_String(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		task Task
		want string
	}{
		{
			name: "default task",
			task: Task{Title: "buy milk", Status: StatusTodo, Priority: PriorityDefault},
			want: "[Todo] buy milk",
		},
		{
			name: "task with a due date",
			task: Task{
				Title:    "buy milk",
				Status:   StatusTodo,
				Priority: PriorityDefault,
				Due:      time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC),
			},
			want: "[Todo] buy milk (due 2026-10-20)",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			assert.Equal(t, tt.want, tt.task.String())
		})
	}
}

func TestTask_String_Snapshots(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		task Task
	}{
		{
			name: "default task",
			task: Task{Title: "buy milk", Status: StatusTodo, Priority: PriorityDefault},
		},
		{
			name: "done task",
			task: Task{Title: "buy milk", Status: StatusDone, Priority: PriorityDefault},
		},
		{
			name: "task with a due date",
			task: Task{
				Title:    "buy milk",
				Status:   StatusTodo,
				Priority: PriorityDefault,
				Due:      time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC),
			},
		},
		{
			name: "done task with a due date",
			task: Task{
				Title:    "buy milk",
				Status:   StatusDone,
				Priority: PriorityDefault,
				Due:      time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC),
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			snaps.WithConfig(snaps.Raw()).MatchSnapshot(t, tt.task.String())
		})
	}
}

func TestStatus_UnmarshalText(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		text    string
		want    Status
		wantErr bool
	}{
		{
			name: "Todo is accepted",
			text: "Todo",
			want: StatusTodo,
		},
		{
			name: "Done is accepted",
			text: "Done",
			want: StatusDone,
		},
		{
			name:    "unknown status is rejected",
			text:    "Nope",
			wantErr: true,
		},
		{
			name:    "empty status is rejected",
			text:    "",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			var got Status
			err := got.UnmarshalText([]byte(tt.text))
			if tt.wantErr {
				var ve ValidationError
				require.ErrorAs(t, err, &ve)
				assert.Equal(t, "status", ve.Field)
				return
			}

			require.NoError(t, err)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestTask_JSONRoundTrip(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		task Task
	}{
		{
			name: "all fields round-trip",
			task: Task{
				ID:       uuid.MustParse("0199c0de-0000-7000-8000-000000000007"),
				Version:  2,
				Title:    "write the book",
				Status:   StatusDone,
				Priority: PriorityMax,
				Due:      time.Date(2026, 10, 20, 12, 30, 0, 0, time.UTC),
				Tags:     []string{"go", "writing"},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			data, err := json.Marshal(tt.task)
			require.NoError(t, err)
			assert.Contains(t, string(data), `"Status":"Done"`)
			// uuid.UUID is an encoding.TextMarshaler, so the id rides the
			// canonical dashed string form, not an array of sixteen bytes.
			assert.Contains(t, string(data), `"ID":"`+tt.task.ID.String()+`"`)

			var got Task
			require.NoError(t, json.Unmarshal(data, &got))
			assert.Equal(t, tt.task, got)
		})
	}
}

func TestTask_JSON_UnknownStatus(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		input       string
		wantMention string
	}{
		{
			name:        "unknown status is reported with its value",
			input:       `{"Title":"x","Status":"Nope"}`,
			wantMention: "Nope",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			var got Task
			err := json.Unmarshal([]byte(tt.input), &got)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tt.wantMention)
		})
	}
}

func TestPriority_Valid(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		priority Priority
		want     bool
	}{
		{name: "zero is below the range", priority: 0, want: false},
		{name: "minimum", priority: PriorityMin, want: true},
		{name: "two", priority: 2, want: true},
		{name: "default", priority: PriorityDefault, want: true},
		{name: "four", priority: 4, want: true},
		{name: "maximum", priority: PriorityMax, want: true},
		{name: "six is above the range", priority: 6, want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			assert.Equal(t, tt.want, tt.priority.Valid())
		})
	}
}

func TestParseDue(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 10, 13, 15, 30, 0, 0, time.UTC)

	tests := []struct {
		name    string
		input   string
		want    time.Time
		wantErr bool
	}{
		{
			name:  "absolute date",
			input: "2026-01-02",
			want:  time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC),
		},
		{
			name:  "today",
			input: "today",
			want:  time.Date(2026, 10, 13, 0, 0, 0, 0, time.UTC),
		},
		{
			name:  "tomorrow",
			input: "tomorrow",
			want:  time.Date(2026, 10, 14, 0, 0, 0, 0, time.UTC),
		},
		{
			name:  "whitespace-padded input",
			input: "  TODAY \t",
			want:  time.Date(2026, 10, 13, 0, 0, 0, 0, time.UTC),
		},
		{
			name:    "empty string is rejected",
			input:   "",
			wantErr: true,
		},
		{
			name:    "malformed date is rejected",
			input:   "2026-13-40",
			wantErr: true,
		},
		{
			name:    "unknown word is rejected",
			input:   "yesterday",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got, err := ParseDue(tt.input, now)
			if tt.wantErr {
				var ve ValidationError
				require.ErrorAs(t, err, &ve)
				assert.Equal(t, "due", ve.Field)
				return
			}

			require.NoError(t, err)
			assert.Equal(t, tt.want, got)
			assert.Equal(t, time.UTC, got.Location())
		})
	}
}

func FuzzParseDue(f *testing.F) {
	now := time.Date(2026, 10, 13, 15, 30, 0, 0, time.UTC)

	for _, seed := range []string{"2026-01-02", "today", "tomorrow", "", "garbage"} {
		f.Add(seed)
	}

	f.Fuzz(func(t *testing.T, input string) {
		got, err := ParseDue(input, now)
		if err != nil {
			return
		}

		normalized := strings.ToLower(strings.TrimSpace(input))
		var want time.Time
		switch normalized {
		case "today":
			want = time.Date(2026, 10, 13, 0, 0, 0, 0, time.UTC)
		case "tomorrow":
			want = time.Date(2026, 10, 14, 0, 0, 0, 0, time.UTC)
		default:
			parsed, err := time.Parse("2006-01-02", normalized)
			if err != nil {
				t.Fatalf(
					"ParseDue(%q) = %v, accepted input %q is neither today, tomorrow, nor a 2006-01-02 date",
					input, got, normalized,
				)
			}
			want = parsed
		}

		if !got.Equal(want) {
			t.Fatalf("ParseDue(%q) = %v, want %v", input, got, want)
		}
		if got.Location() != time.UTC {
			t.Fatalf("ParseDue(%q) location = %v, want UTC", input, got.Location())
		}
	})
}

func FuzzStatusUnmarshalText(f *testing.F) {
	for _, seed := range []string{"Todo", "Done", "", "nope"} {
		f.Add(seed)
	}

	f.Fuzz(func(t *testing.T, input string) {
		var got Status
		if err := got.UnmarshalText([]byte(input)); err != nil {
			return
		}

		if got != StatusTodo && got != StatusDone {
			t.Fatalf("UnmarshalText(%q) accepted %q, want Todo or Done", input, got)
		}

		text, err := got.MarshalText()
		if err != nil {
			t.Fatalf("MarshalText() after UnmarshalText(%q): %v", input, err)
		}
		if string(text) != input {
			t.Fatalf("MarshalText() = %q, want %q after UnmarshalText(%q)", text, input, input)
		}
	})
}
````
