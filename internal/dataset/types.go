// Package dataset imports and freezes Detroit v2 datasets without executing
// model calls, setup commands, tools, or scoring programs.
package dataset

import "encoding/json"

const (
	MaxDocumentBytes = 16 << 20
	MaxBlobBytes     = 256 << 20
	MaxBundleBytes   = 4 << 30
)

type Document = map[string]any

// Bundle retains all exchange fields, including extensions. Blobs are referenced
// by digest; their bytes live alongside the frozen bundle, never in RunSpec.
type Bundle struct {
	Dataset  Document   `json:"dataset"`
	Cases    []Document `json:"cases"`
	Scorings []Document `json:"scorings"`
}

type Notice struct {
	Code     string `json:"code"`
	Document string `json:"document"`
	Message  string `json:"message"`
}

type Options struct {
	Store string
	// Base is a frozen snapshot containing cases for separately distributed scoring.
	Base                       string
	ConfirmValidationConflicts bool
}

type ImportResult struct {
	Path                string   `json:"path"`
	Snapshot            string   `json:"snapshot"`
	DatasetDigest       string   `json:"dataset_digest"`
	Cases               int      `json:"cases"`
	Warnings            []Notice `json:"warnings"`
	RejectedScorings    []Notice `json:"rejected_scorings"`
	ValidationConflicts []Notice `json:"validation_conflicts"`
}

// LoadedCase keeps evaluator-only information outside Task.Input.
type LoadedCase struct {
	ID            string
	Suite         string
	MaxSteps      int
	Meta          map[string]string
	Input         json.RawMessage
	TaskDigest    string
	DatasetDigest string
	Weight        float64
	GroupKey      string
	Purpose       string
	Scorings      []json.RawMessage
}
