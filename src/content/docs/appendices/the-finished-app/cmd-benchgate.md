---
title: "cmd/benchgate — the finished app"
sidebar:
  hidden: true
tableOfContents: false
pagefind: false
---


Part of [The finished app (spoilers)](/appendices/the-finished-app/).


## `cmd/benchgate/main.go`

````go
// Command benchgate is the benchmark regression gate: it builds the test
// binaries of two revisions — the one a committed baseline names in its
// `# control-ref:` header line, and the working tree — runs them alternately
// against the same workload, and fails when the current tree is slower than
// the control by more than the policy allows.
//
// The two-binary shape is chapter 12's interleaving method made executable.
// A gate that compares a fresh run against committed numbers is comparing
// two sessions: the machine's load, frequency, and thermal state move the
// numbers by more than most regressions do, and no statistic can see that
// from the samples. Running both revisions in the same session, alternately,
// gives them the same conditions — and it makes the gate portable: it does
// not matter which machine it runs on, because both sides ran there.
//
// What is gated, and how, is internal/benchgate's policy: zero tolerance for
// extra allocations, five percent for bytes, twenty-five percent for time,
// and nothing at all for a difference benchstat's test cannot separate from
// noise.
//
// Usage:
//
//	go run ./cmd/benchgate -benchstat='go run golang.org/x/perf/cmd/benchstat@vX' ./internal/store ./internal/web ./internal/api
//
// Each package is gated against every baseline file under
// <pkg>/testdata/bench/ that carries a `# control-ref: <rev>` header line; a
// baseline without one is a record, reported and skipped. -update rewrites
// those files with a fresh run and the current revision as the new control.
package main

import (
	"archive/tar"
	"bytes"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"todo/internal/benchgate"
)

func main() {
	err := run()
	switch {
	case err == nil:
		return
	case errors.Is(err, errRegression):
		// The gate ran and found a regression: exit 1, which is what a CI
		// step and a human both read as "the tree is worse".
		fmt.Fprintln(os.Stderr, "benchgate:", err)
		os.Exit(1)
	default:
		// The gate could not run — a usage error, a missing revision, a
		// build that failed. Exit 125, git bisect's "skip this commit":
		// a predicate that cannot run must not report the commit as bad,
		// or bisect blames whatever it tested while the gate was broken.
		fmt.Fprintln(os.Stderr, "benchgate:", err)
		os.Exit(125)
	}
}

// options is the gate's configuration, assembled from the flags.
type options struct {
	pkgs      []string
	count     int
	bench     string
	benchstat string
	control   string
	update    bool
	keep      bool
	policy    benchgate.Policy
}

// controlPrefix marks the header line a gated baseline carries: the revision
// whose test binary the gate builds as the comparison's control.
const controlPrefix = "# control-ref: "

// errNoBenchMatch reports that a -bench pattern selects none of a suite's
// benchmarks, which is a skip for that suite, not a failure of the gate.
var errNoBenchMatch = errors.New("no benchmark matches -bench")

// errRegression is the gate's verdict: the tree is worse than the control by
// more than the policy allows. Every other error is "the gate could not
// run", which exits differently on purpose (see main).
var errRegression = errors.New("the gate found a regression")

// parseFlags reads the command line.
func parseFlags(args []string) (options, error) {
	var opts options
	fs := flag.NewFlagSet("benchgate", flag.ContinueOnError)
	fs.Func("pkg", "package to gate (repeatable; default ./internal/store, ./internal/web, ./internal/api)", func(pkg string) error {
		opts.pkgs = append(opts.pkgs, pkg)
		return nil
	})
	fs.IntVar(&opts.count, "count", 5, "samples per side")
	fs.StringVar(&opts.bench, "bench", "", "extra benchmark filter, on top of each baseline's own names")
	fs.StringVar(&opts.benchstat, "benchstat", "", "benchstat invocation, such as 'go run golang.org/x/perf/cmd/benchstat@vX.Y.Z' (required)")
	fs.StringVar(&opts.control, "control", "", "override the control revision (default: each baseline's # control-ref)")
	fs.BoolVar(&opts.update, "update", false, "rewrite the gated baselines with a fresh run and the current revision as the control")
	fs.BoolVar(&opts.keep, "keep", false, "keep the gate's scratch directory (it prints the path)")
	fs.Float64Var(&opts.policy.Allocs, "allocs", 0, "largest tolerated allocs/op regression, as a fraction (negative disables)")
	fs.Float64Var(&opts.policy.Bytes, "bytes", 0.05, "largest tolerated B/op regression, as a fraction (negative disables)")
	fs.Float64Var(&opts.policy.Secs, "secs", 0.25, "largest tolerated sec/op regression, as a fraction (negative disables)")
	if err := fs.Parse(args); err != nil {
		return options{}, err
	}
	if len(opts.pkgs) == 0 {
		opts.pkgs = []string{"./internal/store", "./internal/web", "./internal/api"}
	}
	if opts.benchstat == "" {
		return options{}, fmt.Errorf("-benchstat is required; the Makefile pins it (see make bench-gate)")
	}
	// benchstat's test over n samples a side cannot return a p-value below
	// 2/(n(n+1)) — with three samples that is 0.1, so no difference could
	// ever clear a 0.05 alpha and the time half of the gate would be dead.
	// Four is the smallest count that can say "significant".
	if opts.count < 4 {
		return options{}, fmt.Errorf("-count %d is too few: benchstat cannot reach p<0.05 with fewer than 4 samples per side", opts.count)
	}
	opts.policy.Alpha = benchgate.DefaultPolicy().Alpha
	return opts, nil
}

// suite is one baseline file: the benchmark names it holds, the filter that
// selects them, and the control revision it names.
type suite struct {
	pkg      string
	path     string
	names    []string
	filter   string
	control  string
	recorded bool // carries a control-ref header
}

func run() error {
	opts, err := parseFlags(os.Args[1:])
	if err != nil {
		return err
	}
	if err := ensureRepo(); err != nil {
		return err
	}

	tmp, err := os.MkdirTemp("", "benchgate-*")
	if err != nil {
		return err
	}
	if opts.keep {
		fmt.Printf("scratch: %s\n", tmp)
	} else {
		defer func() { _ = os.RemoveAll(tmp) }()
	}

	failed := false
	for _, pkg := range opts.pkgs {
		ok, err := gatePackage(opts, pkg, tmp)
		if err != nil {
			return fmt.Errorf("%s: %w", pkg, err)
		}
		if !ok {
			failed = true
		}
	}
	if failed {
		return errRegression
	}
	fmt.Println("benchgate: pass")
	return nil
}

// gatePackage gates one package: it reads the package's baselines, builds the
// control and current test binaries, runs the interleaved capture, and prints
// the verdict.
func gatePackage(opts options, pkg, tmp string) (bool, error) {
	suites, err := readSuites(pkg)
	if err != nil {
		return false, err
	}
	gated := slices.DeleteFunc(slices.Clone(suites), func(s suite) bool { return !s.recorded })
	for _, s := range suites {
		if !s.recorded {
			fmt.Printf("%s: %s is a record, not gated (no %q line)\n", pkg, s.path, strings.TrimSpace(controlPrefix))
		}
	}
	if len(gated) == 0 {
		fmt.Printf("%s: nothing to gate\n", pkg)
		return true, nil
	}

	control := opts.control
	if control == "" {
		for _, s := range gated {
			if s.control == "" {
				return false, fmt.Errorf("%s names no control", s.path)
			}
		}
	}

	controls := map[string]string{}
	controlFor := func(s suite) (string, string, error) {
		rev := control
		if rev == "" {
			rev = s.control
		}
		if bin, ok := controls[rev]; ok {
			return bin, rev, nil
		}
		bin, err := buildControl(opts, pkg, rev, tmp)
		if err != nil {
			return "", "", err
		}
		controls[rev] = bin
		return bin, rev, nil
	}
	currentBin, err := buildCurrent(opts, pkg, tmp)
	if err != nil {
		return false, err
	}

	fmt.Printf("bench gate: %s (%d samples per side)\n", pkg, opts.count)
	if opts.update {
		return true, updateSuites(opts, gated, currentBin, tmp)
	}

	ok := true
	for _, s := range gated {
		controlBin, rev, err := controlFor(s)
		if err != nil {
			return false, err
		}
		fmt.Printf("\n  %s (control %s)\n", s.path, rev)
		controlOut := filepath.Join(tmp, strings.ReplaceAll(s.path, string(filepath.Separator), "_")+".control")
		currentOut := controlOut + ".current"
		if err := capture(opts, controlBin, currentBin, s, controlOut, currentOut, tmp); err != nil {
			if errors.Is(err, errNoBenchMatch) {
				fmt.Printf("  skipped: no benchmark matches -bench %q\n", opts.bench)
				continue
			}
			return false, err
		}
		if empty(controlOut) {
			fmt.Printf("  no comparable rows: the control does not run this suite's benchmarks\n")
			continue
		}
		verdict, err := compare(opts, controlOut, currentOut)
		if err != nil {
			return false, err
		}
		report(verdict, opts.policy)
		if !verdict.OK() {
			ok = false
		}
	}
	return ok, nil
}

// empty reports whether a capture holds no benchmark lines, which is what a
// control revision that predates the suite produces.
func empty(path string) bool {
	data, err := os.ReadFile(path) // #nosec G304 -- the path is the gate's own capture file in its scratch directory
	if err != nil {
		return false
	}
	return !strings.Contains(string(data), "Benchmark")
}

// capture runs the two binaries alternately, one round each per sample, so
// every pair of samples shares the machine's conditions. Each side gets one
// discarded warm-up round first: the first benchmark in a process pays for
// lazy page loads and the seeded database's first touch, and neither side
// should carry that alone.
func capture(opts options, controlBin, currentBin string, s suite, controlOut, currentOut, tmp string) error {
	filter := s.filter
	if opts.bench != "" {
		// -bench narrows the suite: a focused run — the bisect predicate, a
		// single suspicious benchmark — selects the names the pattern
		// matches. A suite with no matching names is skipped by the caller.
		re, err := regexp.Compile(opts.bench)
		if err != nil {
			return fmt.Errorf("-bench %q: %w", opts.bench, err)
		}
		var names []string
		for _, name := range s.names {
			if re.MatchString(name) {
				names = append(names, name)
			}
		}
		if len(names) == 0 {
			return errNoBenchMatch
		}
		filter = nameFilter(names)
	}
	run := func(bin, side string, out io.Writer) error {
		return runBench(bin, filter, filepath.Join(tmp, side+".db"), out)
	}
	appendRun := func(bin, side, out string) error {
		f, err := os.OpenFile(out, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600) // #nosec G304 -- the path is the gate's own capture file in its scratch directory
		if err != nil {
			return err
		}
		defer func() { _ = f.Close() }()
		return run(bin, side, f)
	}
	if err := run(controlBin, "control", io.Discard); err != nil {
		return err
	}
	if err := run(currentBin, "current", io.Discard); err != nil {
		return err
	}
	for i := 0; i < opts.count; i++ {
		if err := appendRun(controlBin, "control", controlOut); err != nil {
			return err
		}
		if err := appendRun(currentBin, "current", currentOut); err != nil {
			return err
		}
	}
	return nil
}

// compare runs benchstat over the two captures and applies the policy.
func compare(opts options, controlOut, currentOut string) (benchgate.Verdict, error) {
	args := append(strings.Fields(opts.benchstat), "-format", "csv", controlOut, currentOut)
	cmd := exec.Command(args[0], args[1:]...) // #nosec G204 -- the command is the benchstat pin the Makefile passes, and the paths are the gate's own captures
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return benchgate.Verdict{}, fmt.Errorf("benchstat: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return benchgate.Compare(&stdout, opts.policy)
}

// report prints one suite's table and its failures.
func report(verdict benchgate.Verdict, policy benchgate.Policy) {
	var metric benchgate.Metric
	for _, row := range verdict.Rows {
		if row.Metric != metric {
			metric = row.Metric
			fmt.Printf("  %s\n", metric)
		}
		delta := benchgate.FormatPercent(row.Delta)
		mark := " "
		if !row.Significant {
			mark = "~"
		} else if budget, gated := policy.Budget(row.Metric); gated && row.Delta > budget {
			mark = "!"
		}
		fmt.Printf("  %s %-46s %14s -> %-14s %9s  %s\n", mark, row.Benchmark,
			benchgate.FormatValue(row.Metric, row.Control), benchgate.FormatValue(row.Metric, row.Current), delta, row.P)
	}
	for _, f := range verdict.Failures {
		fmt.Printf("\n  FAIL %s %s: %s (budget %s)\n", f.Row.Benchmark, f.Row.Metric,
			benchgate.FormatPercent(f.Row.Delta), benchgate.FormatPercent(f.Budget))
	}
}

// updateSuites rewrites each gated baseline with a fresh run and the current
// revision as its control. The run is the same shape a gate run captures: one
// discarded warm-up, then -count samples — a baseline recorded from one cold
// sample would be a weaker floor than the gate it exists for.
func updateSuites(opts options, suites []suite, currentBin, tmp string) error {
	rev, err := git("rev-parse", "HEAD")
	if err != nil {
		return err
	}
	rev = strings.TrimSpace(rev)
	for _, s := range suites {
		if err := runBench(currentBin, s.filter, filepath.Join(tmp, "update.db"), io.Discard); err != nil {
			return err
		}
		var out bytes.Buffer
		for i := 0; i < opts.count; i++ {
			if err := runBench(currentBin, s.filter, filepath.Join(tmp, "update.db"), &out); err != nil {
				return err
			}
		}
		body := out.String()
		at := strings.Index(body, "\nBenchmark")
		if at < 0 {
			return fmt.Errorf("%s: the fresh run reported no benchmarks", s.path)
		}
		body = body[:at+1] + controlPrefix + rev + "\n" + body[at+1:]
		if err := os.WriteFile(s.path, []byte(body), 0o600); err != nil { // #nosec G306 -- a baseline is a record, and 0600 is what the committed one carries
			return err
		}
		fmt.Printf("updated %s (control %s, %d samples)\n", s.path, rev, opts.count)
	}
	return nil
}

// readSuites reads a package's baseline files.
func readSuites(pkg string) ([]suite, error) {
	dir := filepath.Join(strings.TrimPrefix(pkg, "./"), "testdata", "bench")
	paths, err := filepath.Glob(filepath.Join(dir, "*.txt"))
	if err != nil {
		return nil, err
	}
	if len(paths) == 0 {
		return nil, fmt.Errorf("no baselines under %s", dir)
	}
	var suites []suite
	for _, path := range paths {
		data, err := os.ReadFile(path) // #nosec G304 -- the path is a baseline under the package's testdata directory, found by glob
		if err != nil {
			return nil, err
		}
		s := suite{pkg: pkg, path: path}
		for _, line := range strings.Split(string(data), "\n") {
			switch {
			case strings.HasPrefix(line, controlPrefix):
				s.control = strings.TrimSpace(strings.TrimPrefix(line, controlPrefix))
				s.recorded = true
			case strings.HasPrefix(line, "Benchmark"):
				s.names = append(s.names, benchmarkName(line))
			}
		}
		s.filter = nameFilter(s.names)
		suites = append(suites, s)
	}
	return suites, nil
}

// benchmarkName strips the -N GOMAXPROCS suffix from a benchmark output line,
// leaving the name a -bench filter matches.
func benchmarkName(line string) string {
	name := strings.Fields(line)[0]
	if i := strings.LastIndex(name, "-"); i > 0 {
		if _, err := strconv.Atoi(name[i+1:]); err == nil {
			return name[:i]
		}
	}
	return name
}

// nameFilter builds the -bench pattern that selects the given benchmark
// names. The pattern names top-level benchmarks only — the part before the
// first slash — because testing splits a filter on unbracketed slashes and
// matches each part against one element of a benchmark's name: a pattern that
// spells a sub-name cannot also be an alternation of whole names. Selecting
// the top level runs every sub-benchmark of a selected name, which is what a
// suite wants: the baseline's sub-names are compared, and a sub-benchmark the
// control did not have is reported unpaired rather than silently skipped.
func nameFilter(names []string) string {
	seen := make(map[string]bool, len(names))
	var parts []string
	for _, name := range names {
		top, _, _ := strings.Cut(name, "/")
		if seen[top] {
			continue
		}
		seen[top] = true
		parts = append(parts, regexp.QuoteMeta(top))
	}
	return "^(" + strings.Join(parts, "|") + ")$"
}

// buildControl extracts the control revision and builds its test binary for
// the package. The tree arrives through git archive rather than a worktree:
// the gate reads history, it does not create state in the repository.
func buildControl(opts options, pkg, rev, tmp string) (string, error) {
	dir := filepath.Join(tmp, "control-"+sanitize(rev))
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return "", err
	}
	if err := extract(rev, dir); err != nil {
		return "", err
	}
	bin := filepath.Join(tmp, "control-"+sanitize(pkg)+".test")
	return bin, buildTest(dir, pkg, bin)
}

// buildCurrent builds the working tree's test binary for the package.
func buildCurrent(opts options, pkg, tmp string) (string, error) {
	bin := filepath.Join(tmp, "current-"+sanitize(pkg)+".test")
	return bin, buildTest(".", pkg, bin)
}

// buildTest compiles a package's test binary in dir.
func buildTest(dir, pkg, out string) error {
	cmd := exec.Command("go", "test", "-c", "-o", out, pkg) // #nosec G204 -- pkg is a package path from the gate's own flags, and out is in its scratch directory
	cmd.Dir = dir
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("go test -c %s: %w", pkg, err)
	}
	return nil
}

// runBench runs one test binary's benchmarks into out. A benchmark run's
// tests are skipped: the gate measures, it does not test.
func runBench(bin, filter, dbPath string, out io.Writer) error {
	cmd := exec.Command(bin, // #nosec G204 -- bin is a test binary the gate just built in its scratch directory
		"-test.run=^$",
		"-test.bench="+filter,
		"-test.benchmem",
		"-test.count=1",
		"-test.timeout=60m",
	)
	cmd.Env = append(os.Environ(), "TODO_PERF_DB="+dbPath)
	cmd.Stdout = out
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("run %s: %w", filepath.Base(bin), err)
	}
	return nil
}

// extract writes the revision's tree into dir through git archive.
func extract(rev, dir string) error {
	cmd := exec.Command("git", "archive", "--format=tar", rev) // #nosec G204 -- rev is a baseline's control ref, read from a committed file
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("git archive %s: %w", rev, err)
	}
	tr := tar.NewReader(stdout)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		path := filepath.Join(dir, filepath.FromSlash(hdr.Name))
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(path, 0o750); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
				return err
			}
			perm := hdr.Mode & 0o777
			// #nosec G304 -- the path comes from the archive of the gate's own control revision
			// #nosec G115 -- perm is masked to permission bits above
			f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(perm))
			if err != nil {
				return err
			}
			if _, err := io.Copy(f, tr); err != nil { // #nosec G110 -- the stream is this repository's own git archive, not untrusted input
				_ = f.Close()
				return err
			}
			if err := f.Close(); err != nil {
				return err
			}
		}
	}
	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("git archive %s: %w", rev, err)
	}
	return nil
}

// git runs one git command in the repository and returns its stdout.
func git(args ...string) (string, error) {
	var stdout, stderr bytes.Buffer
	cmd := exec.Command("git", args...) // #nosec G204 -- the gate's own git calls, with arguments built in this file
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

// ensureRepo fails early and clearly when the gate is run outside a git
// repository, which is where the control revision lives.
func ensureRepo() error {
	if _, err := git("rev-parse", "--git-dir"); err != nil {
		return fmt.Errorf("benchgate needs a git repository: %w", err)
	}
	return nil
}

// sanitize turns a path or revision into a file name.
func sanitize(s string) string {
	return strings.NewReplacer("/", "_", ".", "_", ":", "_").Replace(s)
}
````
