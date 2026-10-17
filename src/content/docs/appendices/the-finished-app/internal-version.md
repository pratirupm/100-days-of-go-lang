---
title: "internal/version — the finished app"
sidebar:
  hidden: true
tableOfContents: false
pagefind: false
---


Part of [The finished app (spoilers)](/100-days-of-go-lang/appendices/the-finished-app/).


## `internal/version/version.go`

````go
// Package version owns the one string every binary reports about itself.
//
// The variable is the seam the release stamps through: GoReleaser passes
// -ldflags "-X todo/internal/version.Version={{ .Version }}", and the import
// path in that flag is the contract. A package of its own — rather than a
// variable in internal/cli — is what keeps the name stable and the stamp
// reachable from every main under cmd/. The default is honest on purpose: a
// binary built from a working tree is not a release, and "dev" says so.
package version

// Version is the release version, stamped at build time. A plain `go build`
// leaves the default; only the release pipeline changes it, and only to the
// tag the commit was built for.
var Version = "dev"
````
