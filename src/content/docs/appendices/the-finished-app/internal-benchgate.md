---
title: "internal/benchgate — the finished app"
sidebar:
  hidden: true
tableOfContents: false
pagefind: false
---


Part of [The finished app (spoilers)](/100-days-of-go-lang/appendices/the-finished-app/).


## `internal/benchgate/benchgate.go`

````go
// Package benchgate is the policy half of the benchmark gate: it reads the
// comparison table benchstat prints in its CSV format and decides which rows
// are regressions. It does no measuring of its own — cmd/benchgate builds the
// two test binaries, runs them, and calls benchstat; this package is the part
// that can be unit-tested without a machine.
//
// The split matters because the policy is the interesting half. benchstat
// answers "did these two sets of samples differ, and how much"; a gate needs
// the second question — "does this difference matter" — and that is a
// decision with thresholds, not a statistic. The thresholds live here, in one
// place, with the reasoning: an allocation count is deterministic (the same
// code allocates the same number of objects on any machine, so any increase
// is a change, and a budget of zero is honest); bytes per op is nearly as
// deterministic (a map's growth or a slice's capacity can wobble by a few
// percent between runs, so the budget is 5%); and seconds per op is the noisy
// one (a shared machine's load, frequency, and thermal state move it, so the
// budget is 25% — the gate is looking for the class of regression that
// matters, not for noise).
//
// A row whose comparison benchstat marks "~" is not a regression whatever its
// median says: the samples did not separate. The gate reports such rows and
// does not fail on them, which is the difference between a gate and a
// random number generator.
package benchgate

import (
	"encoding/csv"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// Metric is one column family of benchstat's table: the three quantities a
// benchmark reports.
type Metric string

const (
	// SecOp is seconds per operation.
	SecOp Metric = "sec/op"
	// BytesOp is bytes allocated per operation.
	BytesOp Metric = "B/op"
	// AllocsOp is allocations per operation.
	AllocsOp Metric = "allocs/op"
)

// Row is one benchmark's comparison for one metric.
type Row struct {
	// Metric is the column family the row belongs to.
	Metric Metric
	// Benchmark is the benchmark's full name, the pairing key.
	Benchmark string
	// Control and Current are the two medians. Current is zero when the
	// current run has no samples for the benchmark (a benchmark that was
	// removed); Control is zero when the control has none (a benchmark that
	// was added).
	Control, Current float64
	// Delta is the relative change of Current against Control, as a
	// fraction: 0.1 is ten percent slower.
	Delta float64
	// P is benchstat's verdict text, such as "p=0.000 n=5"; empty when the
	// row has no comparison.
	P string
	// ControlCI and CurrentCI are benchstat's confidence intervals for the
	// two medians, as fractions; zero means every sample was identical.
	ControlCI, CurrentCI float64
	// Significant reports whether the two sets separated: benchstat's test
	// returned a p below the policy's alpha, or — for the count metrics —
	// every sample on both sides was identical and the medians still
	// differ. The second rule matters because a deterministic count is not
	// a sample: with three runs a side benchstat's test can never reach
	// p < 0.05, and an allocation count that never varied is the code's
	// number, not an estimate of it.
	Significant bool
}

// exact reports whether both sides' samples were identical — benchstat's
// zero-width confidence interval — which is what a deterministic metric
// produces.
func (r Row) exact() bool {
	return r.ControlCI == 0 && r.CurrentCI == 0 && r.Control != r.Current
}

// Policy is the gate's thresholds. Each threshold is the largest regression
// that passes, as a fraction; a negative threshold disables that check.
type Policy struct {
	// Alpha is the p-value below which benchstat's difference counts as
	// significant.
	Alpha float64
	// Allocs is the tolerated regression in allocations per op.
	Allocs float64
	// Bytes is the tolerated regression in bytes per op.
	Bytes float64
	// Secs is the tolerated regression in seconds per op.
	Secs float64
}

// DefaultPolicy is the policy the gate runs with when no flags override it:
// zero tolerance for extra allocations, five percent for bytes, twenty-five
// percent for time, and benchstat's default alpha.
func DefaultPolicy() Policy {
	return Policy{Alpha: 0.05, Allocs: 0, Bytes: 0.05, Secs: 0.25}
}

// Budget returns the policy's budget for a metric, and whether the metric is
// gated at all. A budget of zero passes only a zero regression; a negative
// budget disables the metric.
func (p Policy) Budget(m Metric) (float64, bool) {
	var t float64
	switch m {
	case AllocsOp:
		t = p.Allocs
	case BytesOp:
		t = p.Bytes
	case SecOp:
		t = p.Secs
	default:
		return 0, false
	}
	return t, t >= 0
}

// Failure is one row the gate refuses to pass.
type Failure struct {
	Row Row
	// Budget is the threshold the row exceeded, as a fraction.
	Budget float64
}

// Verdict is the gate's answer: every comparison row, and the failures.
type Verdict struct {
	// Rows are all comparison rows, in the order benchstat printed them.
	Rows []Row
	// Failures are the rows over budget. The gate fails when this is not
	// empty.
	Failures []Failure
}

// OK reports whether the verdict passes: no failures.
func (v Verdict) OK() bool { return len(v.Failures) == 0 }

// Compare reads benchstat's CSV comparison and applies the policy. The CSV is
// what `benchstat -format csv control.txt current.txt` prints; the metric
// section headers (",sec/op,CI,sec/op,CI,vs base,P") are what tell the
// sections apart, and the geomean rows are skipped — the gate's unit is the
// benchmark, and a summary that mixes a 1.6-second read with a 200-nanosecond
// scan is not a budget.
func Compare(r io.Reader, policy Policy) (Verdict, error) {
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1 // the header and data rows differ in length

	var (
		verdict Verdict
		metric  Metric
	)
	for {
		rec, err := cr.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return Verdict{}, fmt.Errorf("read benchstat csv: %w", err)
		}
		if len(rec) < 2 {
			continue // the goos/goarch/pkg/cpu preamble
		}
		if rec[0] == "" {
			// A section header: the metric name sits in the second column.
			metric = Metric(strings.TrimSpace(rec[1]))
			continue
		}
		if rec[0] == "geomean" || metric == "" {
			continue
		}
		row, ok := parseRow(metric, rec, policy.Alpha)
		if !ok {
			continue
		}
		if row.exact() && (row.Metric == AllocsOp || row.Metric == BytesOp) {
			row.Significant = true
		}
		verdict.Rows = append(verdict.Rows, row)
		if budget, gated := policy.Budget(row.Metric); gated && row.Significant && row.Delta > budget {
			verdict.Failures = append(verdict.Failures, Failure{Row: row, Budget: budget})
		}
	}
	return verdict, nil
}

// parseRow turns one comparison line into a Row: name, control median, CI,
// current median, CI, "vs base", P. A row whose comparison column is "~" is
// reported with Significant false. A row missing one side — a benchmark only
// one run has — is reported with the missing median zero and never
// significant.
func parseRow(metric Metric, rec []string, alpha float64) (Row, bool) {
	if len(rec) < 6 {
		return Row{}, false
	}
	name := rec[0]
	control, err := parseFloat(rec[1])
	if err != nil {
		return Row{}, false
	}
	current, err := parseFloat(rec[3])
	if err != nil {
		return Row{}, false
	}
	// -1 is "no confidence interval was reported", which is what a row with
	// one side missing carries; a reported 0 is a zero-width interval, every
	// sample identical.
	row := Row{Metric: metric, Benchmark: name, Control: control, Current: current, ControlCI: -1, CurrentCI: -1}
	if ci, err := parsePercent(rec[2]); err == nil {
		row.ControlCI = ci
	}
	if ci, err := parsePercent(rec[4]); err == nil {
		row.CurrentCI = ci
	}

	vs := strings.TrimSpace(rec[5])
	if vs != "" && vs != "~" {
		delta, err := parsePercent(vs)
		if err != nil {
			return Row{}, false
		}
		row.Delta = delta
	}
	if len(rec) >= 7 {
		row.P = strings.TrimSpace(rec[6])
		if p, ok := parseP(row.P); ok && p < alpha {
			row.Significant = true
		}
	}
	return row, true
}

// parseFloat reads a benchstat cell: a plain decimal, possibly in scientific
// notation ("3.218729e+06").
func parseFloat(s string) (float64, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, nil
	}
	return strconv.ParseFloat(s, 64)
}

// parsePercent reads a "vs base" cell, such as "+15.00%" or "-7.28%", as a
// fraction.
func parsePercent(s string) (float64, error) {
	s = strings.TrimSuffix(strings.TrimSpace(s), "%")
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, err
	}
	return v / 100, nil
}

// parseP reads a P cell, such as "p=0.000 n=5" or "p=1.000 n=5", and returns
// the p-value.
func parseP(s string) (float64, bool) {
	rest, ok := strings.CutPrefix(s, "p=")
	if !ok {
		return 0, false
	}
	value, _, _ := strings.Cut(rest, " ")
	p, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return 0, false
	}
	return p, true
}

// FormatPercent renders a fraction as the sign and one decimal benchstat
// prints, so the gate's report and the tool's table agree.
func FormatPercent(f float64) string {
	return fmt.Sprintf("%+.2f%%", f*100)
}

// FormatValue renders a median the way a reader compares it: an integer for
// counts, and the natural unit for the two continuous metrics.
func FormatValue(m Metric, v float64) string {
	switch m {
	case AllocsOp:
		return strconv.FormatFloat(v, 'f', 0, 64)
	case BytesOp:
		return strconv.FormatFloat(v, 'f', 0, 64)
	default:
		return strconv.FormatFloat(v, 'f', 4, 64) + "s"
	}
}
````


## `internal/benchgate/benchgate_test.go`

````go
package benchgate

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// sampleCSV is a benchstat -format csv comparison with the shapes the gate
// must tell apart: a significant allocation regression, a significant byte
// regression, a significant time regression, a row whose difference benchstat
// called noise, a row that improved, and a benchmark only one side ran.
const sampleCSV = `goos: linux
goarch: amd64
cpu: a cpu
,/tmp/control.txt,,/tmp/current.txt,,,
,sec/op,CI,sec/op,CI,vs base,P
ByTagRare/n=100000-16,0.03506,6%,0.2,3%,+470.00%,p=0.000 n=5
List/n=100000-16,1.589,7%,1.60,7%,~,p=0.190 n=5
ListAdded/n=100000-16,,,1.0,1%,,p=1.000 n=1
ListRemoved/n=100000-16,1.0,1%,,,,p=1.000 n=1
Get/n=100000-16,0.0001351,8%,0.00012,4%,-11.18%,p=0.000 n=5
geomean,10.0,,10.5,,+5.00%,

,/tmp/control.txt,,/tmp/current.txt,,,
,B/op,CI,B/op,CI,vs base,P
ByTagRare/n=100000-16,7222,0%,9000,0%,+24.62%,p=0.000 n=5
List/n=100000-16,382948904,0%,362324260,0%,-5.38%,p=0.000 n=5
geomean,1.0e+06,,1.1e+06,,+10.00%,

,/tmp/control.txt,,/tmp/current.txt,,,
,allocs/op,CI,allocs/op,CI,vs base,P
ByTagRare/n=100000-16,283,0%,400,0%,+41.34%,p=0.000 n=5
List/n=100000-16,11972255,0%,11986913,0%,+0.12%,p=0.000 n=5
geomean,,,,,+0.00%,
`

func TestCompare(t *testing.T) {
	verdict, err := Compare(strings.NewReader(sampleCSV), DefaultPolicy())
	require.NoError(t, err)

	// Every comparison row is reported; the geomeans are not.
	assert.Len(t, verdict.Rows, 9)
	assert.False(t, verdict.OK())
	require.Len(t, verdict.Failures, 4)
	assert.Equal(t, Failure{Row: Row{
		Metric: SecOp, Benchmark: "ByTagRare/n=100000-16",
		Control: 0.03506, Current: 0.2, Delta: 4.7, P: "p=0.000 n=5",
		ControlCI: 0.06, CurrentCI: 0.03, Significant: true,
	}, Budget: 0.25}, verdict.Failures[0])
	assert.Equal(t, BytesOp, verdict.Failures[1].Row.Metric)
	assert.Equal(t, AllocsOp, verdict.Failures[2].Row.Metric)
	assert.Equal(t, AllocsOp, verdict.Failures[3].Row.Metric)
	assert.Equal(t, "List/n=100000-16", verdict.Failures[3].Row.Benchmark)
}

func TestCompare_NoiseIsNotAFailure(t *testing.T) {
	// The List row's time moved, but benchstat called it noise: the gate
	// reports it and does not fail on it. (The same benchmark's allocation
	// row did move — by 0.12%, significantly — and that one fails, which is
	// the policy's zero allocation budget doing its job.)
	verdict, err := Compare(strings.NewReader(sampleCSV), DefaultPolicy())
	require.NoError(t, err)

	var found bool
	for _, row := range verdict.Rows {
		if row.Metric == SecOp && row.Benchmark == "List/n=100000-16" {
			found = true
			assert.False(t, row.Significant, "a ~ row must not count as significant")
		}
	}
	assert.True(t, found)
	for _, f := range verdict.Failures {
		if f.Row.Metric == SecOp {
			assert.NotEqual(t, "List/n=100000-16", f.Row.Benchmark,
				"the row benchstat called noise must not fail")
		}
	}
}

func TestCompare_ImprovementsPass(t *testing.T) {
	// Get is 11% faster and its rows pass.
	verdict, err := Compare(strings.NewReader(sampleCSV), DefaultPolicy())
	require.NoError(t, err)
	for _, f := range verdict.Failures {
		assert.NotEqual(t, "Get/n=100000-16", f.Row.Benchmark)
	}
}

func TestCompare_UnpairedBenchmarksAreReported(t *testing.T) {
	verdict, err := Compare(strings.NewReader(sampleCSV), DefaultPolicy())
	require.NoError(t, err)

	var added, removed bool
	for _, row := range verdict.Rows {
		if row.Benchmark == "ListAdded/n=100000-16" {
			added = true
			assert.Zero(t, row.Control)
			assert.False(t, row.Significant, "a benchmark with no control cannot be a regression")
		}
		if row.Benchmark == "ListRemoved/n=100000-16" {
			removed = true
			assert.Zero(t, row.Current)
		}
	}
	assert.True(t, added, "the added benchmark must be reported")
	assert.True(t, removed, "the removed benchmark must be reported")
}

func TestCompare_PolicyDisables(t *testing.T) {
	// A disabled check passes whatever the row says.
	policy := DefaultPolicy()
	policy.Secs = -1
	verdict, err := Compare(strings.NewReader(sampleCSV), policy)
	require.NoError(t, err)
	for _, f := range verdict.Failures {
		assert.NotEqual(t, SecOp, f.Row.Metric)
	}
}

func TestCompare_ThresholdsAreFractions(t *testing.T) {
	// With the time budget at 5x, the 470% time regression passes; the
	// allocation and byte regressions do not, because their budgets are
	// unchanged.
	policy := DefaultPolicy()
	policy.Secs = 5
	verdict, err := Compare(strings.NewReader(sampleCSV), policy)
	require.NoError(t, err)
	require.Len(t, verdict.Failures, 3)
	for _, f := range verdict.Failures {
		assert.NotEqual(t, SecOp, f.Row.Metric)
	}
	assert.Equal(t, "ByTagRare/n=100000-16", verdict.Failures[0].Row.Benchmark)
	assert.Equal(t, BytesOp, verdict.Failures[0].Row.Metric)
	assert.Equal(t, AllocsOp, verdict.Failures[1].Row.Metric)
	assert.Equal(t, "List/n=100000-16", verdict.Failures[2].Row.Benchmark)
}

func TestParseP(t *testing.T) {
	for _, tt := range []struct {
		in    string
		want  float64
		found bool
	}{
		{"p=0.000 n=5", 0, true},
		{"p=0.190 n=5", 0.19, true},
		{"p=1.000 n=10", 1, true},
		{"~", 0, false},
		{"", 0, false},
	} {
		got, found := parseP(tt.in)
		assert.Equal(t, tt.found, found, tt.in)
		assert.Equal(t, tt.want, got, tt.in)
	}
}

func TestFormat(t *testing.T) {
	assert.Equal(t, "+15.00%", FormatPercent(0.15))
	assert.Equal(t, "-5.38%", FormatPercent(-0.0538))
	assert.Equal(t, "11986913", FormatValue(AllocsOp, 11986913))
	assert.Equal(t, "362324260", FormatValue(BytesOp, 362324260))
	assert.Equal(t, "1.5890s", FormatValue(SecOp, 1.589))
}

func TestCompare_ExactCountsAreSignificant(t *testing.T) {
	// A deterministic metric's samples are identical on each side; with
	// three samples a side benchstat's test cannot reach p<0.05, so the
	// policy would be blind to a real count change. Zero-width intervals
	// and different medians are the code's numbers, not an estimate.
	const csv = `goos: linux
,/tmp/control.txt,,/tmp/current.txt,,,
,allocs/op,CI,allocs/op,CI,vs base,P
Exact/n=100-16,283,0%,400,0%,+41.34%,p=1.000 n=3
Noisy/n=100-16,283,2%,400,3%,+41.34%,p=1.000 n=3
`
	verdict, err := Compare(strings.NewReader(csv), DefaultPolicy())
	require.NoError(t, err)
	require.Len(t, verdict.Rows, 2)
	assert.True(t, verdict.Rows[0].Significant, "identical samples with different medians are a real difference")
	assert.False(t, verdict.Rows[1].Significant, "a noisy row benchstat could not separate is not")
	require.Len(t, verdict.Failures, 1)
	assert.Equal(t, "Exact/n=100-16", verdict.Failures[0].Row.Benchmark)
}
````
