---
title: Export and import
description: Write every task to a file as JSON, read it back, and replace the file in one step that never leaves half a document.
sidebar:
  order: 19
---

Every task we have stored lives in memory, and when the program stops they
are gone. Today we give them somewhere to go: a file.

The file will hold **JSON** — text that other programs can read. JSON is
braces, brackets, and quoted text: a person can open the file and read it,
and our app can read it back. We met JSON when tasks learned to write
themselves as text; now it becomes a whole document.

**Export** writes every task out as one document. **Import** reads a document
and adds every task in it to a store. And the file they meet in gets a
promise: it is replaced in one step, so a reader sees the old document or the
new one — never half of either.

We write the tests first, as always.

## The document

Before code writes the document, we agree on its shape: one JSON object with
a version number, then the tasks.

```text
{"version":1,"tasks":[...]}
```

The `...` stands for the tasks, one after another. Each task is written the
way we already write one as text — `"Status":"Done"` for a completed task,
`"Due":"2026-11-01T00:00:00Z"` for a due date.

The `version` field is a promise to the future. A later build that changes
the shape writes version 2 — and a reader that only knows version 1 says so
instead of guessing. A version that is written but never checked is
decoration; ours will be checked.

## Three functions over the store

Today's code lives in `internal/store/export.go`, beside the store it works
on. Three functions:

- `ExportJSON(ctx, s, w)` writes the store's tasks to `w` — anything that
  accepts text, such as a file or a buffer in a test.
- `ImportJSON(ctx, s, r)` reads a document from `r`, adds every task to the
  store, and reports how many it added.
- `WriteExportFile(ctx, s, path)` writes the document to a file in one
  visible step.

They are functions that take a store, not methods on one: export asks the
store to `List`, import asks it to `Add`. Nothing here knows which kind of
store it is talking to, so when the store's engine changes, these three
functions do not move — and nothing else changes either.

## Write the tests first

Create `internal/store/export_test.go`, next to the store's other test files.
Its imports are the ones those files use, plus `bytes`, `encoding/json`,
`fmt`, `io`, `os`, `path/filepath`, and `strings`; the compiler will name
anything you miss. The finished app's appendix holds this file in full — read
the parts behind the `...` there as you type them.

Every test is built around one fixture: three tasks, so every case can spell
the same expected document.

<!-- verify: internal/store/export_test.go at=export-import -->
```go title="internal/store/export_test.go"
var exportDue = time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)

...
func exportSeeds() []task.Task {
	return []task.Task{
		{Title: "write tests", Status: task.StatusTodo, Priority: task.PriorityDefault, Due: exportDue, Tags: []string{"go", "book"}},
		{Title: "review code", Status: task.StatusTodo, Priority: task.PriorityMax, Tags: []string{"review"}},
		{Title: "ship it", Status: task.StatusTodo, Priority: task.PriorityMin},
	}
}
```

The first task carries a due date and two labels, the second gets completed
in the round-trip test, and the third has neither — so the document touches
every field a task has.

## The round trip

The first test, `TestExportImport_RoundTrip`, exports the fixture and imports
it into a fresh store.

<!-- verify: internal/store/export_test.go at=export-import -->
```go title="internal/store/export_test.go"
	seeds := exportSeeds()
	source := mustStore(t, seeds...)
	require.NoError(t, source.Complete(context.Background(), 2))

	var buf bytes.Buffer
	require.NoError(t, ExportJSON(context.Background(), source, &buf))

	...
	raw := buf.String()
	assert.True(t, strings.HasPrefix(raw, fmt.Sprintf(`{"version":%d,"tasks":[`, exportVersion)),
		"document opens with the v1 envelope header: %s", raw)
	assert.Contains(t, raw, `"Status":"Done"`)
	assert.Contains(t, raw, `"Due":"2026-11-01T00:00:00Z"`)
```

`bytes.Buffer` collects text in memory; in a test it stands in for a file.
`mustStore` builds a store holding the given tasks, and `Complete` marks the
second task done so the document carries both statuses. The `assert` lines
read the raw document: it opens with the exact header, the completed task
says `"Done"`, and the due date crosses in the standard text form for times.

Then the document comes back:

<!-- verify: internal/store/export_test.go at=export-import -->
```go title="internal/store/export_test.go"
	target := NewMemoryStore()
	n, err := ImportJSON(context.Background(), target, strings.NewReader(raw))
	require.NoError(t, err)
	assert.Equal(t, len(seeds), n)

	want := []task.Task{
		{ID: 1, Title: "write tests", Status: task.StatusTodo, Priority: task.PriorityDefault, Due: exportDue, Tags: []string{"go", "book"}},
		{ID: 2, Title: "review code", Status: task.StatusDone, Priority: task.PriorityMax, Tags: []string{"review"}},
		{ID: 3, Title: "ship it", Status: task.StatusTodo, Priority: task.PriorityMin},
	}
	got, err := target.List(context.Background())
	require.NoError(t, err)
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("imported tasks mismatch (-want +got):\n%s", diff)
	}
```

`strings.NewReader` turns the text into something readable, the way a file
is. `n` is how many tasks the import added, and `cmp.Diff` compares the
rebuilt tasks with the expected ones field by field. The second expected task
is `Done`, because the export was taken after `Complete`.

## What the reader refuses, and what it allows

Four smaller tests pin the rules of reading a document.

An import is not a restore. The document carries ids, but the importing store
assigns its own, exactly as `Add` always does — the test is
`TestImportJSON_AssignsFreshIDs`:

<!-- verify: internal/store/export_test.go at=export-import -->
```go title="internal/store/export_test.go"
	s := mustStore(t, task.Task{Title: "existing", Status: task.StatusTodo})
	doc := `{"version":1,"tasks":[{"ID":42,"Title":"imported","Status":"Todo","Priority":3}]}`

	n, err := ImportJSON(context.Background(), s, strings.NewReader(doc))
	require.NoError(t, err)
	assert.Equal(t, 1, n)

	got, err := s.List(context.Background())
	require.NoError(t, err)
	require.Len(t, got, 2)
	assert.Equal(t, 2, got[1].ID, "the store's next id, not the document's 42")
	assert.Equal(t, "imported", got[1].Title)
```

The document says `"ID":42`; the imported task lands with id 2. The
document's ids are the exporting store's numbering, meaningful inside the
document and nowhere else.

The version is read, not just written —
`TestImportJSON_RejectsUnknownVersion`:

<!-- verify: internal/store/export_test.go at=export-import -->
```go title="internal/store/export_test.go"
	s := NewMemoryStore()
	doc := fmt.Sprintf(`{"version":%d,"tasks":[{"ID":1,"Title":"later","Status":"Todo","Priority":3}]}`, exportVersion+1)

	n, err := ImportJSON(context.Background(), s, strings.NewReader(doc))
	require.Error(t, err)
	assert.Zero(t, n)
	assert.Contains(t, err.Error(), fmt.Sprintf("version %d", exportVersion+1))

	list, err := s.List(context.Background())
	require.NoError(t, err)
	assert.Empty(t, list, "an unknown version is refused before any task is added")
```

`exportVersion+1` builds a document from the next version without spelling
the number. The reader refuses it before adding anything: the count is zero
and the store is empty.

A malformed task names its position —
`TestImportJSON_MalformedElementNamesIndex`:

<!-- verify: internal/store/export_test.go at=export-import -->
```go title="internal/store/export_test.go"
			s := NewMemoryStore()
			n, err := ImportJSON(context.Background(), s, strings.NewReader(tt.doc))
			require.Error(t, err)
			assert.Contains(t, err.Error(), "task 1", "the error names the malformed element's index")
			assert.Equal(t, 1, n)

			got, err := s.List(context.Background())
			require.NoError(t, err)
			require.Len(t, got, 1, "the element before the malformed one landed")
			assert.Equal(t, "fine", got[0].Title)
```

The table above these lines holds two documents: one whose second task
carries `"Status":"Blocked"`, which the decoder refuses, and one that is
broken JSON. Both fail at the second task, and the error says `task 1`,
counting from zero. The first task is already in the store: the import adds
as it reads.

One more test keeps the reader flexible —
`TestImportJSON_IgnoresUnknownTaskFields`:

<!-- verify: internal/store/export_test.go at=export-import -->
```go title="internal/store/export_test.go"
	s := NewMemoryStore()
	doc := `{"version":1,"tasks":[{"ID":1,"Title":"from the future","Status":"Todo","Priority":3,"Colour":"blue"}]}`

	n, err := ImportJSON(context.Background(), s, strings.NewReader(doc))
	require.NoError(t, err)
	assert.Equal(t, 1, n)
```

`"Colour"` is a field this build does not know, and the import succeeds
anyway: JSON skips fields a type does not declare. A build that grows a task
field needs no new version; a change that breaks the shape does.

## Prove it streams

Import reads the document one task at a time instead of reading all of it
first. That claim gets a test of its own —
`TestImportJSON_StreamsFromAChunkedReader` — built from a reader that hands
over one byte per call and counts them:

<!-- verify: internal/store/export_test.go at=export-import -->
```go title="internal/store/export_test.go"
type byteCountingReader struct {
	data []byte
	read int
}

func (r *byteCountingReader) Read(p []byte) (int, error) {
	if r.read >= len(r.data) {
		return 0, io.EOF
	}
	p[0] = r.data[r.read]
	r.read++
	return 1, nil
}
```

A store that wraps `MemoryStore` records the reader's count at the moment
each task is added. An importer that swallowed the whole document first would
record the same number every time; this test asserts that every recorded
position is short of the document's end, and that the first add happened
before the second. That is what "adds as it reads" means.

## Prove the file survives a failure

`WriteExportFile` writes to a real file, and files fail: disks fill,
directories refuse writes, programs are killed. Three tests pin the
destination around a failure.

The first, `TestWriteExportFile_NoTempLeftovers`, exports three times and
checks the directory afterwards; `t.TempDir()` gives the test a fresh
directory that is removed when the test ends:

<!-- verify: internal/store/export_test.go at=export-import -->
```go title="internal/store/export_test.go"
	dir := t.TempDir()
	path := filepath.Join(dir, "tasks.json")
	s := mustStore(t, exportSeeds()...)

	for range 3 {
		require.NoError(t, WriteExportFile(context.Background(), s, path))
	}

	entries, err := os.ReadDir(dir)
	require.NoError(t, err)
	require.Len(t, entries, 1, "only the export file remains after writes")
	assert.Equal(t, "tasks.json", entries[0].Name())
```

After three exports the directory holds exactly one file — the export — and
no leftovers. A lingering `.tmp-` file is what a crash can leave behind; a
successful write must not.

The middle test, `TestWriteExportFile_FailedWriteKeepsOldFile`, makes the
directory read-only with `os.Chmod(dir, 0o500)`, so the temp file cannot be
created at all, then checks that the export file's bytes are exactly the ones
from before the failure. It skips itself when
running as root, because root ignores directory permissions.

The last test, `TestWriteExportFile_SourceFailureRemovesTemp`, fails the
document's source instead:

<!-- verify: internal/store/export_test.go at=export-import -->
```go title="internal/store/export_test.go"
	errBoom := errors.New("list failed")
	dir := t.TempDir()
	path := filepath.Join(dir, "tasks.json")

	s := listErrStore{MemoryStore: NewMemoryStore(), err: errBoom}
	err := WriteExportFile(context.Background(), s, path)
	require.ErrorIs(t, err, errBoom, "the source's error travels unchanged")

	entries, err := os.ReadDir(dir)
	require.NoError(t, err)
	assert.Empty(t, entries, "the failed export left no temp file and no destination")
```

`listErrStore` is a store whose `List` fails. The write reports that error
unchanged, and the directory is left empty — no temp file, no destination.

## Watch it fail

The test file cannot build yet, and that is the point. Run the tests:

```bash
$ go test -count=1 ./...
```

```text
# todo/internal/store [todo/internal/store.test]
internal/store/export_test.go:50:21: undefined: ExportJSON
internal/store/export_test.go:57:79: undefined: exportVersion
internal/store/export_test.go:63:12: undefined: ImportJSON
internal/store/export_test.go:90:12: undefined: ImportJSON
internal/store/export_test.go:109:103: undefined: exportVersion
internal/store/export_test.go:111:12: undefined: ImportJSON
internal/store/export_test.go:114:60: undefined: exportVersion
internal/store/export_test.go:157:14: undefined: ImportJSON
internal/store/export_test.go:182:12: undefined: ImportJSON
internal/store/export_test.go:237:21: undefined: ExportJSON
internal/store/export_test.go:237:21: too many errors
ok  	todo/cmd/todo	0.003s
FAIL	todo/internal/store [build failed]
ok  	todo/internal/task	0.004s
FAIL
```

Every line is a name that does not exist yet. `undefined: ExportJSON` means
Go looked for the function and found nothing. The compiler stops after ten
errors, so `WriteExportFile` and `exportDoc` are waiting behind the cut; your
line numbers will differ, but the names are what matter. The other two
packages pass, so the rest of the app is untouched.

## Write the exporter

Now the code. Start `internal/store/export.go` with the format's declaration:
the version number and the shape of the document.

<!-- verify: internal/store/export.go at=export-import -->
```go title="internal/store/export.go"
const exportVersion = 1

...
type exportDoc struct {
	Version int         `json:"version"` // 1
	Tasks   []task.Task `json:"tasks"`
}
```

`exportVersion` is the number the writer writes and the reader accepts;
`exportDoc` is the document's one declared spelling — a version, then the
tasks. The backtick notes after each field tell the JSON package which name
to use in the text.

The exporter writes the header by hand and one task at a time:

<!-- verify: internal/store/export.go at=export-import -->
```go title="internal/store/export.go"
	bw := bufio.NewWriter(w)
	if _, err := fmt.Fprintf(bw, `{"version":%d,"tasks":[`, exportVersion); err != nil {
		return fmt.Errorf("export tasks: %w", err)
	}
	for i, t := range tasks {
		if i > 0 {
			if err := bw.WriteByte(','); err != nil {
				return fmt.Errorf("export tasks: %w", err)
			}
		}
		...
		data, err := json.Marshal(t)
		if err != nil {
			return fmt.Errorf("export tasks: task %d: %w", i, err)
		}
		if _, err := bw.Write(data); err != nil {
			return fmt.Errorf("export tasks: %w", err)
		}
	}
```

Read it in three parts. `bufio.NewWriter(w)` wraps the destination in a
buffer: many small writes are collected and sent on in fewer, larger batches.
The `Fprintf` writes the opening `{"version":1,"tasks":[`. Then, for each
task, `json.Marshal(t)` turns one task into its text, which is written and
dropped before the next task is touched; a comma separates the tasks.

A store with a hundred thousand tasks would need one huge piece of text in
memory if we wrote the document in one go. This shape holds one task's text
at a time, and the buffer's 4 KB. Two lines follow the loop — the closing
`]}` and one `Flush` that sends whatever the buffer still holds.

The function opens with the context check every store method uses and one
`List` call, so the document is a snapshot: a change made while it is being
written is not part of it. On a write error, the bytes already written stay
written — which is exactly why the file writer, in a moment, writes to a temp
file first.

## Write the importer

The importer reads the document with a `json.Decoder`, which walks a document
piece by piece instead of reading it whole. First the envelope: the opening
brace, the `"version"` field, and the number — refused if it is not the
version this build knows.

<!-- verify: internal/store/export.go at=export-import -->
```go title="internal/store/export.go"
	tok, err = d.Token()
	if err != nil {
		return 0, fmt.Errorf("import tasks: %w", err)
	}
	if tok != "version" {
		return 0, fmt.Errorf("import tasks: expected the version field, found %q", tok)
	}
	var version int
	if err := d.Decode(&version); err != nil {
		return 0, fmt.Errorf("import tasks: version: %w", err)
	}
	if version != exportVersion {
		return 0, fmt.Errorf("import tasks: unsupported version %d, want %d", version, exportVersion)
	}
```

`Token` returns the next structural piece — a brace, a bracket, a field name.
`Decode` reads the next whole value. The version is read before the array, so
a document from an unknown version is refused before a single task is added.
The reader takes the `"tasks"` field name and the opening `[` the same way,
then reads the elements one at a time:

<!-- verify: internal/store/export.go at=export-import -->
```go title="internal/store/export.go"
	count := 0
	for d.More() {
		var t task.Task
		if err := d.Decode(&t); err != nil {
			return count, fmt.Errorf("import tasks: task %d: %w", count, err)
		}
		if _, err := s.Add(ctx, t); err != nil {
			return count, fmt.Errorf("import tasks: task %d: %w", count, err)
		}
		count++
	}
```

`d.More()` asks whether the array has another element, `Decode` reads one
task, and `Add` stores it. `count` is both how many tasks were added and the
zero-based position of the one being read — which is why a failure can name
it (`task 1` is the second element). `Add` receives the context, so a
cancellation stops at the next element.

After the loop, two `Token` calls close the array and the object, and one
more read must report the end of the file — so a second document cannot ride
behind the first. The ids arrive fresh: `Add` assigns this store's own.

## Write the file in one step

The last function writes the document to a real file. A file rewritten in
place can be caught half-written; `WriteExportFile` avoids that by writing
somewhere else and renaming.

<!-- verify: internal/store/export.go at=export-import -->
```go title="internal/store/export.go"
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".tmp-*")
	if err != nil {
		return fmt.Errorf("write export file: create temp file in %s: %w", dir, err)
	}
	tmpName := tmp.Name()

	...
	defer func() {
		if tmpName != "" {
			_ = os.Remove(tmpName)
		}
	}()
```

`os.CreateTemp` creates a brand-new file beside the destination, named
`<destination>.tmp-` followed by a random part. The deferred function removes
it on any failure before the rename; success clears `tmpName`, so the remove
is skipped. The document is streamed into the temp:

<!-- verify: internal/store/export.go at=export-import -->
```go title="internal/store/export.go"
	if err := ExportJSON(ctx, s, tmp); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write export file: sync temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("write export file: close temp file: %w", err)
	}
	if err := os.Chmod(tmpName, 0o644); err != nil { // #nosec G302 -- the export file is user data, meant to be world-readable like the files it backs up
		return fmt.Errorf("write export file: chmod temp file: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("write export file: replace %s: %w", path, err)
	}
	tmpName = ""
```

`ExportJSON(ctx, s, tmp)` writes the document into the temp file — the same
function as before, with the file as its writer. Then `Sync` pushes the bytes
to the disk, `Close` finishes the file, and `os.Rename` gives the temp the
destination's name in one step. The `Chmod` sets the file's permissions to
the mode ordinary files get, because the rename carries the temp file's
permissions along.

The temp lives in the destination's own directory because rename cannot cross
from one filesystem to another — `/tmp` is usually a different disk. The
promise is narrow and strong: a reader of the destination sees the previous
document or the new one, never half of either. A crash between the write and
the rename can leave a `.tmp-` file behind, but the destination still holds
the old document, whole.

## Run everything

```bash
$ go test -count=1 ./...
```

```text
ok  	todo/cmd/todo	0.003s
ok  	todo/internal/store	0.011s
ok  	todo/internal/task	0.004s
```

Nine tests pass: the round trip, fresh ids, the version refusal, the two
malformed documents, unknown fields, the chunked reader, and three file
tests. The file tests push on real files and real permissions, so a
repetition run is the honest check:

```bash
$ go test -race -count=50 -run 'TestExportImport|TestImportJSON|TestWriteExportFile' ./internal/store
```

```text
ok  	todo/internal/store	1.301s
```

Fifty runs in a row pass.

The file ends with two benchmarks. `BenchmarkExport` writes to `io.Discard` —
a writer that throws text away — so it measures the encoding; `BenchmarkImport`
exports the document once and imports it into a fresh store on every
repetition:

<!-- verify: internal/store/export_test.go at=export-import -->
```go title="internal/store/export_test.go"
// BenchmarkExport measures one full export of a seeded store. The writer is
// io.Discard: the cost under measurement is the encoding — the bufio writer,
// one json.Marshal per task, the header and the separators — not the
// destination. The call writes to its writer, so it cannot be optimized
// away; no sink is needed.
func BenchmarkExport(b *testing.B) {
	for _, n := range benchSizes {
		s := seedStore(n)
		b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				if err := ExportJSON(benchCtx, s, io.Discard); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// BenchmarkImport measures one full import of the document the same store
// exports, into a fresh store each iteration: the decode of every task plus
// the Add that stores it, which is what an import actually costs. The
// document is exported once, before the timer starts.
func BenchmarkImport(b *testing.B) {
	for _, n := range benchSizes {
		var buf bytes.Buffer
		if err := ExportJSON(benchCtx, seedStore(n), &buf); err != nil {
			b.Fatal(err)
		}
		doc := buf.Bytes()
		b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				s := NewMemoryStore()
				if _, err := ImportJSON(benchCtx, s, bytes.NewReader(doc)); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
```

The allocations scale with the number of tasks, not the size of the document —
about four per exported task and seven per imported one.

## If something went wrong

**A document from a newer build.** The import reports:

```text
import tasks: unsupported version 2, want 1
```

Nothing is broken — the version check is doing its job. A document claiming a
shape this build does not know is refused before a task is added, instead of
being misread as version 1. When you change the shape in a way older readers
cannot understand, bump `exportVersion` and teach the reader the versions it
still accepts. A change that only adds a task field needs no bump.

**A task that fails in the middle.** The import reports:

```text
import tasks: task 1: invalid status: unknown status "Blocked"
```

Read it as two facts. `task 1` is the second task, counting from zero, and
the document's first task is already in the store — the import adds as it
reads, and is not all-or-nothing. If you need all-or-nothing, import into a
fresh store and throw it away when the import fails.

**`invalid cross-device link`.** A temp file created in the wrong place:

```text
rename /tmp/exdev-probe-1544812725 …/exdev-probe/run-1140280982/tasks.json: invalid cross-device link
```

Renaming a file gives it a new name; it cannot move the bytes to another
filesystem, and `/tmp` is usually a different disk. The fix is the one the
code makes: the temp in `filepath.Dir(path)` — the destination's own
directory, same filesystem, one rename.

<details>
<summary>Going deeper: why write one task at a time</summary>

Writing the whole document at once would be simpler. It would also hold every
task's text in memory at the same time, and its peak would grow with the
document. The shape we chose is not cheaper — it is bounded. A probe over a
store of 1,000 tasks measured both shapes; the second one builds the whole
document in one go:

```text
document: 112200 bytes for 1000 tasks
export streaming: peak live +77496 bytes, max write 4096 bytes
export materialized: peak live +249624 bytes, max write 112200 bytes
import streaming: peak live +174776 bytes, max read request 1536 bytes, count 1000
import materialized: peak live +270656 bytes, max read request 57344 bytes, count 1000
```

The streaming export's peak is the store's snapshot plus the buffer's 4 KB;
the materializing one adds the document itself and the growth of building it.
The streaming import's reader never asked for more than 1,536 bytes at a
time; the materializing one read the whole document in one 57,344-byte
request. This document is the seam a backup of a large store flows through,
so the bound is the point.

</details>

<details>
<summary>Going deeper: what needs a new version, and what does not</summary>

Adding a task field needs no new version: JSON skips fields a type does not
declare. Removing or renaming one breaks older readers — it bumps the
version, and an older reader refuses it instead of guessing.

</details>

Next: the store's tasks move into a real database — and these three
functions will not move.
