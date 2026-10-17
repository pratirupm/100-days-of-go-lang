---
title: Output formats
day: 32
time: "3 hours"
description: Give the tool two voices — an aligned table for people and a stable JSON shape for programs — behind one flag.
sidebar:
  order: 27
---

The tool talks in sentences now. `todo list` prints one line per task — the id, then `[Todo] buy milk (due 2026-11-01)` — which is pleasant for one line and painful for a list. The columns don't line up, so your eyes do the sorting.

A program has a worse time. To find the tasks due this week, a script would have to pick the date out of a sentence that was written for people. Nothing about that wording was ever a promise, so the first reworded line would break the script.

Today the output splits by audience. People get an aligned table: one task per row, one value per column. Programs get JSON — a text format for data, where every value carries a name, its **key** — behind a single `--json` flag that every command accepts.

The JSON shape becomes a promise in this chapter, pinned by a test. The table is for reading; the JSON is for depending.

## The tests come first

The test file moves before the code, as always. Three things change in `internal/cli/cli_test.go`: the list fixture grows a fourth task, `TestList` expects the table instead of the old sentence, and five new tests pin the machine forms. Two more tests arrive at the end of the chapter, where the formats get recorded — a recorded file needs the real output to record, so those come after the code prints it.

The new fixture task is the table's hardest case: a task with a label but no due date. Every row still carries a cell for the due date — empty where there is none — and that is what keeps the labels lined up across the whole listing.

<!-- verify: internal/cli/cli_test.go at=output-formats -->
```go title="internal/cli/cli_test.go"
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
```

The helper now returns four tasks, and `water the plants` is the fourth: a label, no due date. Then `TestList`'s three expectations become the table itself.

<!-- verify: internal/cli/cli_test.go at=output-formats -->
```go title="internal/cli/cli_test.go"
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
	// ...
	t.Run("--status filters", func(t *testing.T) {
		// ...
		assert.Equal(t, shipped.ID.String()+"  Done  ship it\n", out)
	})
	// ...
	t.Run("--tag filters", func(t *testing.T) {
		// ...
		assert.Equal(t, milk.ID.String()+"  Todo  buy milk  2026-11-01  home\n", out)
	})
}
```

Each expected line is the row as it should print: id, status, title, due date, labels, with two spaces between the columns. The two filter cases pin a single row each.

The import list grows by four, because the tests that follow decode JSON, sort key names, and split lines: `encoding/json`, `maps`, `slices`, and `strings`. Two more imports — `regexp` and the snapshot library — arrive later, with the tests that use them; Go refuses to build an import nothing uses.

## The JSON tests pin a shape

The heart of the chapter is a test that treats the JSON shape as a promise. It owns its own copy of the shape — a separate type from the one the code will encode — so a renamed key on either side fails here instead of matching silently.

<!-- verify: internal/cli/cli_test.go at=output-formats -->
```go title="internal/cli/cli_test.go"
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
```

`wireTask` is the test's copy of the seven keys, with the types a reader would use: the due date is a pointer, so it can be absent, and the labels are a list.

The contract test decodes every line twice. Once into a map whose key set must match the documented list exactly, and once into `wireTask` with unknown fields refused. The map catches a field nobody documented; the struct catches a renamed or retyped key.

<!-- verify: internal/cli/cli_test.go at=output-formats -->
```go title="internal/cli/cli_test.go"
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
	// ...
	var got []wireTask
	for i, line := range lines {
		var keys map[string]json.RawMessage
		require.NoError(t, json.Unmarshal([]byte(line), &keys), "line %d is one JSON object", i)
		assert.Equal(t, wantKeys, slices.Sorted(maps.Keys(keys)), "line %d carries exactly the documented keys", i)
```

`wantKeys` is the contract in one line: the seven key names, in sorted order. The loop compares that list against the sorted keys of every line. The elided lines in between hold the ids the fixture assigned, in the same order, so each line can be checked against the task it belongs to.

<!-- verify: internal/cli/cli_test.go at=output-formats -->
```go title="internal/cli/cli_test.go"
	// ...
		dec := json.NewDecoder(strings.NewReader(line))
		dec.DisallowUnknownFields()
		var wt wireTask
		require.NoError(t, dec.Decode(&wt), "line %d decodes into the documented struct", i)
		assert.Equal(t, wantIDs[i], wt.ID)
		got = append(got, wt)
	}
	// ...
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
```

The second decode is the other direction: into the test's own `wireTask`, with unknown fields refused, so a renamed or retyped key fails here too. The assertions at the end pin the value rules — a timestamp when there is a due date and `null` when there is not, and an array for the labels even when it is empty.

The single-result commands get smaller versions of the same test. `add` and `done` decode their one object into `wireTask`; `import` pins its exact bytes; and one test guards the output discipline — a failing command must leave stdout empty.

<!-- verify: internal/cli/cli_test.go at=output-formats -->
```go title="internal/cli/cli_test.go"
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
	// ...
	assert.Equal(t, []string{"home"}, got.Tags)
	assert.Equal(t, 1, got.Version)
}
```

`add` runs with `--json` and decodes the one object. The elided middle re-reads the store, so the test checks that the printed task is the stored one; the end pins the labels and the starting version.

<!-- verify: internal/cli/cli_test.go at=output-formats -->
```go title="internal/cli/cli_test.go"
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
	// ...
	assert.Equal(t, task.StatusDone.String(), got.Status)
	assert.Equal(t, added.Version+1, got.Version, "the CAS moves the version with the status")
	assert.Nil(t, got.Due)
	assert.Equal(t, []string{}, got.Tags)
}
```

`done`'s object is the task the store now holds: status `Done`, and a version one higher than the one it was added with.

<!-- verify: internal/cli/cli_test.go at=output-formats -->
```go title="internal/cli/cli_test.go"
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
```

The last two tests: `import`'s exact bytes, and the failure rule — a command that fails writes nothing to stdout, and cobra stays silent so the one error line can belong to `main`.

## Watch them fail

Run the suite:

```bash
$ go test -count=1 ./...
?   	todo/cmd/todo	[no test files]
--- FAIL: TestAdd_JSON (0.00s)
    cli_test.go:303: 
        	Error:      	Received unexpected error:
        	            	unknown flag: --json
        	Test:       	TestAdd_JSON
...
--- FAIL: TestList (0.00s)
    --- FAIL: TestList/plain_lists_every_task_in_insertion_order (0.00s)
        cli_test.go:362: 
            	Error:      	Not equal: 
            	            	expected: "01a13758-26fe-7160-820d-f0254e7f81bd  Todo  buy milk          2026-11-01  home\n01a13758-26fe-7168-95a0-5c0d8fe95c42  Todo  write the book\n01a13758-26fe-7189-ab3c-e090b8397946  Done  ship it\n01a13758-26fe-719f-b7d6-3a96e74e8175  Todo  water the plants              garden\n"
            	            	actual  : "01a13758-26fe-7160-820d-f0254e7f81bd  [Todo] buy milk (due 2026-11-01) (tags: home)\n01a13758-26fe-7168-95a0-5c0d8fe95c42  [Todo] write the book\n01a13758-26fe-7189-ab3c-e090b8397946  [Done] ship it\n01a13758-26fe-719f-b7d6-3a96e74e8175  [Todo] water the plants (tags: garden)\n"
...
FAIL
FAIL	todo/internal/cli	0.012s
ok  	todo/internal/config	0.004s
ok  	todo/internal/db	0.014s
ok  	todo/internal/store	0.079s
?   	todo/internal/store/storetest	[no test files]
ok  	todo/internal/task	0.003s
FAIL
```

The four tests whose job is to read a machine format stop at the parser: `unknown flag: --json` means cobra never handed the flag to a command, so no command body ran. `TestList`'s three cases fail against the old sentence — brackets around the status, the due date in parentheses, the labels after it — and that failure describes the change in full.

Your line numbers will differ; the shapes will not. One new test passes, and honestly so: `TestJSON_ErrorLeavesStdoutEmpty` only checks that stdout stays empty on a failure, and an unknown flag is a failure too.

## One flag for the whole tool

The switch is declared once, on the root command, beside `--db`:

<!-- verify: internal/cli/cli.go at=output-formats -->
```go title="internal/cli/cli.go"
	// --json is persistent so every command inherits it: one format switch
	// for the whole tree, not five copies, and the help lists it with --db
	// under Global Flags on every leaf.
	root.PersistentFlags().BoolVar(&sess.json, "json", false,
		"output JSON instead of the human-readable format")
```

`PersistentFlags` is cobra's word for "every command inherits this": one definition reaches all five commands, and each one's help lists `--json` under Global Flags without a line of its own.

The parsed value has to outlive flag parsing and reach five command bodies, so it lives on the session — the state one run already shares:

<!-- verify: internal/cli/cli.go at=output-formats -->
```go title="internal/cli/cli.go"
// session is the state the commands share: the store the pre-run opened, the
// cleanup the post-run will call, and the output format the --json flag
// chose. One session per New call, reached through a pointer, so nothing
// about a run lives in a package global.
type session struct {
	store   store.Store
	cleanup func() error
	// json is the resolved --json flag. The flag is parsed before any RunE
	// runs, so the commands read this bool instead of the flag itself.
	json bool
}
```

The session gains one field, `json`. The comment says why: the flag is parsed before any command body runs, so the bodies read the bool instead of the flag itself. No command reads the flag directly, the same way no command reads `--db`.

The file's own description gains a paragraph about the new pair of formats:

<!-- verify: internal/cli/cli.go at=output-formats -->
```go title="internal/cli/cli.go"
// Package cli builds the todo command tree: the thin layer that parses
// arguments, calls the store, and formats what it reads. The tree is built
// around its dependencies — an opener for the store and two writers —
// instead of reaching for globals, so the commands are exercised in-process
// and the wiring stays in cmd/todo.
//
// Every command has two output formats: the human default and --json. The
// JSON shapes are a small, documented API — see jsonTask, jsonStats, and
// jsonImport — so scripts can depend on them without depending on the human
// table's layout.
```

That is the file's job description, with the new formats written into it.

## A table for people

The table is one function. It writes five cells per row — id, status, title, due date, labels — and lets `text/tabwriter`, a standard-library tool, line the columns up. The trick that makes the alignment hold is that every row carries all five cells even when a value is missing, because of how the tool pads: it sizes a column to the widest cell in a run of adjacent rows, and a row that ends early breaks that run for everything after it.

The file's imports gain `bytes`, `encoding/json`, and `text/tabwriter` for the new work.

<!-- verify: internal/cli/cli.go at=output-formats -->
```go title="internal/cli/cli.go"
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
```

Read the `Fprintf`: five cells, separated by tabs. The buffer and the last loop exist because the padding that empty cells receive is real spaces at the end of a line — invisible in a terminal, but a pipe or a diff would carry them. So the writer formats into a buffer and strips the trailing whitespace line by line.

`tabwriter.NewWriter(&buf, 0, 0, 2, ' ', 0)` says: no minimum width, pad with spaces, two spaces of padding, no flags. Two spaces between columns is the spacing every earlier format used.

The list command's description changes with its output, and so does its body:

<!-- verify: internal/cli/cli.go at=output-formats -->
```go title="internal/cli/cli.go"
		Long: `List tasks in insertion order as an aligned table: id, status, title, and
the due date and tags when the task has them. --json prints one JSON object
per task instead, one object per line.
```

The help text now promises the table and describes `--json` in the same breath.

<!-- verify: internal/cli/cli.go at=output-formats -->
```go title="internal/cli/cli.go"
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
```

The human path is the fall-through: `--json` takes the branch that writes one object per line, and everything else goes to `writeTaskTable`. The machine branch is the chapter's second promise made concrete — one object per line, not one array around all of them, so a pipe can read whole tasks as they are written.

## A shape for programs

The machine format is not the domain type printed through a different door. It is a small copy that owns the shape: a **DTO**, short for data transfer object, a type that exists for what crosses the boundary rather than for what the app stores.

<!-- verify: internal/cli/cli.go at=output-formats -->
```go title="internal/cli/cli.go"
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
```

Seven keys, lowercase, and the rules are in the comment. `due` is a timestamp in the standard spelling — `2026-11-01T00:00:00Z` — or `null` when the task has no date. The labels array is never `null`, and the version is the store's counter. The comment ends with the rule that keeps the shape usable: change it by adding, never by renaming.

Printing `task.Task` directly would have decided three things for us. Its Go field names are capitalized, so the keys would be `ID` and `Title`, the spelling of the import documents — a different contract with its own history. Its `time.Time` due date marshals a zero value as the timestamp `0001-01-01T00:00:00Z`, so "no due date" would arrive as a year-1 moment every reader has to special-case. And a task with no labels would marshal `null` where readers expect a list to loop over.

The conversion is where those rules become code:

<!-- verify: internal/cli/cli.go at=output-formats -->
```go title="internal/cli/cli.go"
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
```

The due date is set only when the task has one — the pointer stays `nil`, and the encoder writes `null` — and the labels are replaced with an empty list when the task has none. One conversion function means there is one place to read when the shape changes.

## Wire the commands

`add` prints the stored task in the machine format — the value the store confirmed, id and version included — or the id alone for people:

<!-- verify: internal/cli/cli.go at=output-formats -->
```go title="internal/cli/cli.go"
			if sess.json {
				return writeJSON(cmd.OutOrStdout(), newJSONTask(stored))
			}
			_, err = fmt.Fprintln(cmd.OutOrStdout(), stored.ID)
			return err
```

One branch, one line: the JSON form of the stored task, or the id.

`done` prints nothing when it succeeds in the human format, so the machine format is the only report it gives. It re-reads the task after the write instead of guessing at what changed:

<!-- verify: internal/cli/cli.go at=output-formats -->
```go title="internal/cli/cli.go"
			if err := sess.store.Complete(ctx, id, t.Version); err != nil {
				return err
			}
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
```

The comment is the reason for the re-read: the status and version printed are the store's, not a local guess at what the write did.

`stats` prints its three numbers under two shapes, and `import` reports its count. Both are small named types encoded through one helper:

<!-- verify: internal/cli/cli.go at=output-formats -->
```go title="internal/cli/cli.go"
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
```

`jsonStats` and `jsonImport` are the two remaining shapes, and `writeJSON` is the shared encoder: one object, one newline. The `stats` comment loses its note about a later pass and says what `--json` prints instead:

<!-- verify: internal/cli/cli.go at=output-formats -->
```go title="internal/cli/cli.go"
// newStatsCmd builds the stats command: one call to the store's aggregate,
// three printed numbers. --json prints the same three numbers as one object.
```

The body then gains its own branch:

<!-- verify: internal/cli/cli.go at=output-formats -->
```go title="internal/cli/cli.go"
			if sess.json {
				return writeJSON(cmd.OutOrStdout(), jsonStats{
					Total:   stats.Total,
					Done:    stats.Done,
					Pending: stats.Pending,
				})
			}
```

The human block is unchanged; `--json` prints the same three numbers as one object.

<!-- verify: internal/cli/cli.go at=output-formats -->
```go title="internal/cli/cli.go"
			if sess.json {
				return writeJSON(cmd.OutOrStdout(), jsonImport{Imported: n})
			}
```

`import`'s machine form is a single object with the count. `list` writes its own stream because it has many objects to write, one per line; the four single-result commands share `writeJSON`. One thing leaves the file: the old `formatTask` function, the one-line renderer `list` used, has no callers left. Delete it.

## Record the formats that last

The human table is for reading, and it is allowed to change. The JSON is a promise, and promises get pinned. Four outputs deserve a recorded copy: the human table, the JSONL stream, and `stats` in both forms. The snapshot tool the suite already uses returns for them.

One obstacle first. The stores assign UUIDv7 ids, and every run makes new ones, so a recorded file holding a real id would fail on every run and teach us to re-record without reading. The fix is a helper that replaces every id with the placeholder `<id>` before the snapshot sees the output:

<!-- verify: internal/cli/cli_test.go at=output-formats -->
```go title="internal/cli/cli_test.go"
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
```

The pattern matches the canonical id shape anywhere in a string, and `normalizeIDs` replaces every match. The golden then pins everything the id is not: the row order, the columns, the padding, the key names, and even the id's position inside `"id":"<id>"`.

Now the two snapshot tests, and the two imports they need. The first records the table and the stream from one fixture:

<!-- verify: internal/cli/cli_test.go at=output-formats -->
```go title="internal/cli/cli_test.go"
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
```

One table of two cases; each subtest runs the command and hands the output — normalized — to `MatchSnapshot`. The case names become the headings in the recorded file.

The second records `stats` in both forms. It shares a small fixture helper with the existing `TestStats`, which now starts with `st := statsStore(t)` instead of seeding its own:

<!-- verify: internal/cli/cli_test.go at=output-formats -->
```go title="internal/cli/cli_test.go"
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
```

`statsStore` seeds two pending tasks and one done task — the same fixture `TestStats` pinned by hand before.

<!-- verify: internal/cli/cli_test.go at=output-formats -->
```go title="internal/cli/cli_test.go"
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
```

`stats` carries no id, so `normalizeIDs` changes nothing here; it runs anyway because the call sites share one shape.

The file's import list is complete now — `regexp` and the snapshot library joined it:

<!-- verify: internal/cli/cli_test.go at=output-formats -->
```go title="internal/cli/cli_test.go"
import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
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

	"todo/internal/cli"
	"todo/internal/store"
	"todo/internal/task"
)
```

Run just these tests and watch them record:

```bash
$ go test -count=1 -v -run 'TestList_Snapshots|TestStats_Snapshots' ./internal/cli
=== RUN   TestList_Snapshots
=== PAUSE TestList_Snapshots
=== RUN   TestStats_Snapshots
=== PAUSE TestStats_Snapshots
=== CONT  TestList_Snapshots
=== RUN   TestList_Snapshots/human_table
...
=== NAME  TestList_Snapshots/human_table
    cli_test.go:406: ✎ Snapshot added
=== NAME  TestStats_Snapshots/human
    cli_test.go:578: ✎ Snapshot added
=== NAME  TestList_Snapshots/jsonl
    cli_test.go:406: ✎ Snapshot added
--- PASS: TestList_Snapshots (0.00s)
    --- PASS: TestList_Snapshots/human_table (0.00s)
    --- PASS: TestList_Snapshots/jsonl (0.00s)
=== NAME  TestStats_Snapshots/json
    cli_test.go:578: ✎ Snapshot added
--- PASS: TestStats_Snapshots (0.00s)
...
PASS
ok  	todo/internal/cli	0.004s
```

The `PAUSE` and `CONT` lines are the scheduler's business; the four `✎ Snapshot added` lines are the point. The tests passed because they wrote down what the app printed, and the new file is now the thing a person has to read.

Open `internal/cli/__snapshots__/cli_test.snap`:

<!-- verify: internal/cli/__snapshots__/cli_test.snap at=output-formats -->
```text title="internal/cli/__snapshots__/cli_test.snap"

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
```

Read it line by line, the way the review works. The table lines up `home` and `garden` under each other although one task has a due date and the other does not, and no line ends in invisible spaces. In the JSON, `due` is a timestamp for the one task that has a date and `null` for the rest, the labels array is `[]` where there are none, and every object carries exactly the seven keys. The ids are `<id>` — normalized, not real.

## Run it green

```bash
$ go test -count=1 ./...
?   	todo/cmd/todo	[no test files]
ok  	todo/internal/cli	0.011s
ok  	todo/internal/config	0.004s
ok  	todo/internal/db	0.014s
ok  	todo/internal/store	0.093s
?   	todo/internal/store/storetest	[no test files]
ok  	todo/internal/task	0.005s
```

Every package passes, snapshots included. From here on, the same run compares the formats against the reviewed file, and a change to either side shows up as a diff.

## Try the real tool

Build the tool the way you have before — `CGO_ENABLED=0 go build -o ./todo ./cmd/todo` — and run it from a scratch folder. Point `TODO_DB` at a scratch file there, so your real list stays out of the demo:

<!-- transcripts: authored -->
```bash
$ export TODO_DB=$PWD/demo.db
```

Four tasks in, one marked done:

```bash
$ ./todo add "buy milk" --due 2026-11-01 --tag home
01a13765-00e6-705f-a03a-3f0664515979

$ ./todo add "write the book" --priority 5
01a13765-00e9-7598-818b-6f5c6cc4ca32

$ ./todo add "ship it"
01a13765-00ec-7a0c-a385-5290a485762e

$ ./todo add "water the plants" --tag garden
01a13765-00f0-7261-aee7-34b4fb99a7be

$ ./todo done 01a13765-00e6-705f-a03a-3f0664515979

$ ./todo list
01a13765-00e6-705f-a03a-3f0664515979  Done  buy milk          2026-11-01  home
01a13765-00e9-7598-818b-6f5c6cc4ca32  Todo  write the book
01a13765-00ec-7a0c-a385-5290a485762e  Todo  ship it
01a13765-00f0-7261-aee7-34b4fb99a7be  Todo  water the plants              garden
```

The table lines up: `home` and `garden` sit in the same column although only one of those rows has a due date, and no line ends in invisible spaces. The `done` command printed nothing, as it always does.

```bash
$ ./todo list --json
{"id":"01a13765-00e6-705f-a03a-3f0664515979","title":"buy milk","status":"Done","priority":3,"due":"2026-11-01T00:00:00Z","tags":["home"],"version":2}
{"id":"01a13765-00e9-7598-818b-6f5c6cc4ca32","title":"write the book","status":"Todo","priority":5,"due":null,"tags":[],"version":1}
{"id":"01a13765-00ec-7a0c-a385-5290a485762e","title":"ship it","status":"Todo","priority":3,"due":null,"tags":[],"version":1}
{"id":"01a13765-00f0-7261-aee7-34b4fb99a7be","title":"water the plants","status":"Todo","priority":3,"due":null,"tags":["garden"],"version":1}

$ ./todo stats --json
{"total":4,"done":1,"pending":3}

$ ./todo list --json | head -1
{"id":"01a13765-00e6-705f-a03a-3f0664515979","title":"buy milk","status":"Done","priority":3,"due":"2026-11-01T00:00:00Z","tags":["home"],"version":2}
```

The machine formats: one object per task, `null` where a due date is missing, `[]` where the labels are, and the same seven keys everywhere. The first object is the task `done` marked: status `Done` and version 2, the store's values after the write rather than a guess made before it. The pipe line is the one-object-per-line promise made concrete — `head -1` gets a whole task and closes the pipe without waiting for the rest of the list.

```bash
$ ./todo done not-a-uuid --json > stdout.txt 2> stderr.txt; echo "exit: $?"
exit: 1
$ wc -c < stdout.txt
0
$ cat stderr.txt
done: invalid id "not-a-uuid": invalid UUID length: 10
```

`--json` changed nothing about failure: the exit code is 1, stdout holds zero bytes, and the one error line is on stderr. Help states the flag once, on the root, and every command shows it:

```bash
$ ./todo list --help
List tasks in insertion order as an aligned table: id, status, title, and
the due date and tags when the task has them. --json prints one JSON object
per task instead, one object per line.
...
Flags:
  -h, --help            help for list
      --status status   filter by status (Todo or Done)
      --tag string      filter by tag

Global Flags:
      --db string   path to the Turso database; overrides $TODO_DB and the XDG default
      --json        output JSON instead of the human-readable format
```

The long description promises the table and the stream, and `--json` appears under Global Flags, where the inherited `--db` sits.

## If something went wrong

**The labels column splits between rows.** A first cut that leaves the empty cells out looks like this — the second listing is the broken binary, the first is the same data after the fix:

```bash
$ ./todo list
01a13765-00e6-705f-a03a-3f0664515979  Done  buy milk          2026-11-01  home
01a13765-00e9-7598-818b-6f5c6cc4ca32  Todo  write the book
01a13765-00ec-7a0c-a385-5290a485762e  Todo  ship it
01a13765-00f0-7261-aee7-34b4fb99a7be  Todo  water the plants              garden
$ ./todo-broken list
01a13765-00e6-705f-a03a-3f0664515979  Done  buy milk  2026-11-01  home
01a13765-00e9-7598-818b-6f5c6cc4ca32  Todo  write the book
01a13765-00ec-7a0c-a385-5290a485762e  Todo  ship it
01a13765-00f0-7261-aee7-34b4fb99a7be  Todo  water the plants  garden
```

The tool pads a column to the widest cell in a run of rows that have a cell there. A row whose cell ends the line breaks the run, so the rows below get padded to their own widths and the column splits. The fix is five cells on every row — empty strings where a value is missing — plus the strip that removes the trailing spaces those cells receive.

**A task with no due date prints a year-1 timestamp.** If the JSON shows this for a task with no date:

```text
{"due":"0001-01-01T00:00:00Z"}
{"due":null}
```

The first line is the domain's `time.Time` zero value marshaled directly: a valid timestamp for January 1 of year 1. The fix is the DTO's pointer rule — set the field only when the task has a due date — so absence is `null`, the one shape every reader already knows.

**The table tests fail against JSON.** If the switch falls the wrong way, the human tests receive JSON, which reads like the test is wrong:

```text
--- FAIL: TestList (0.00s)
    --- FAIL: TestList/--tag_filters (0.00s)
        cli_test.go:380: 
            	Error:      	Not equal: 
            	            	expected: "01a1376a-c2a6-7d21-b1dd-fed03842e41c  Todo  buy milk  2026-11-01  home\n"
            	            	actual  : "{\"id\":\"01a1376a-c2a6-7d21-b1dd-fed03842e41c\",\"title\":\"buy milk\",…}\n"
            	            	
            	            	Diff:
            	            	--- Expected
            	            	+++ Actual
            	            	@@ -1,2 +1,2 @@
            	            	-01a1376a-c2a6-7d21-b1dd-fed03842e41c  Todo  buy milk  2026-11-01  home
            	            	+{"id":"01a1376a-c2a6-7d21-b1dd-fed03842e41c","title":"buy milk","status":"Todo","priority":3,"due":"2026-11-01T00:00:00Z","tags":["home"],"version":1}
            	            	 
            	Test:       	TestList/--tag_filters
```

The fix is one condition, read once: `sess.json` chooses the machine branch, and the human path is the fall-through. The exact-string tests are the alarm here because they pin the human bytes directly — a recorded file can be re-recorded, an assertion cannot pass by accident.

**The golden fails on every run, with a different id each time.**

```text
--- FAIL: TestList_Snapshots (0.00s)
    --- FAIL: TestList_Snapshots/human_table (0.00s)
        cli_test.go:406: 
            - Snapshot - 4
            + Received + 4
            
            - <id>  Todo  buy milk          2026-11-01  home
            - <id>  Todo  write the book
            - <id>  Done  ship it
            - <id>  Todo  water the plants              garden
            + 01a1376a-c45c-72da-8af1-7981246c8c44  Todo  buy milk          2026-11-01  home
            + 01a1376a-c45c-72e3-8244-a884cb4dd053  Todo  write the book
            + 01a1376a-c45c-72fa-b326-7cc087caae8e  Done  ship it
            + 01a1376a-c45c-7302-ab4b-47b5cbd60b65  Todo  water the plants              garden
              ↵
            
            at __snapshots__/cli_test.snap:14
```

A real id got into the recorded file. Nothing is broken — the file is churning, and a churning file trains us to re-record without reading. The fix is `normalizeIDs` at the call site: the golden should pin the shape and the id's position, not the id.

<details>
<summary>Going deeper: why one object per line?</summary>

`list --json` emits a stream, not a document: one object per line. An array would have to hold every task before printing the first one, wrap the listing in brackets and commas, and make a stream that gets cut off invalid.

Line by line keeps each task whole. The first object is readable as soon as it is written, `list --json | head -1` returns after one task, and tools that read line by line need no parser for a bracketed document.

The single-result commands are the same rule from the other side: when there is exactly one value, one object plus a newline is already a complete document. The format has a name — JSON Lines, or JSONL for short.

</details>

<details>
<summary>Going deeper: why a copy owns the JSON shape?</summary>

The copy — `jsonTask` — exists so the output's key names, types, and rules are a deliberate, reviewable choice. The differences from the domain type are exactly where printing `task.Task` directly would have decided for us: capitalized keys from the import document's spelling, a year-1 timestamp for "no due date", and `null` for an empty label list.

Keeping the copy in step is the cost. `newJSONTask` is the only conversion, so there is one place to read, and the contract test fails the moment the copy and the documented keys disagree. A change is meant to be additive: a new key is fine, but a renamed or retyped one breaks every script that reads it.

</details>

<details>
<summary>Going deeper: the tools and the argument</summary>

Three references are worth keeping. `text/tabwriter` — https://pkg.go.dev/text/tabwriter — explains the column-block rule the five-cell design is built around. https://jsonlines.org/ is the one-page spec behind `list --json`. And the Command Line Interface Guidelines, at https://clig.dev/#output, make the argument this chapter followed: human-readable by default, machine-readable on request, output as a contract. The `encoding/json` reference at https://pkg.go.dev/encoding/json covers the encoder and the decoder the tests use.

</details>

The formats are pinned; next, the tests stop calling commands as functions and run the built binary as a real process.
