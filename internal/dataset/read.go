package dataset

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type source struct {
	bundle Bundle
	root   string
	bytes  int64
}

func readSource(ctx context.Context, path string) (*source, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	s := &source{root: filepath.Dir(path)}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("source must not be a symlink: %s", path)
	}
	if !info.IsDir() {
		if err = s.readFile(ctx, path); err != nil {
			return nil, err
		}
		return s, nil
	}
	s.root = path
	// Read only protocol documents. Never traverse workspaces or execute setup.
	for _, name := range []string{"dataset.json", "cases.jsonl", "scorings.jsonl"} {
		p := filepath.Join(path, name)
		if _, err := os.Lstat(p); os.IsNotExist(err) {
			continue
		}
		if err := s.readFile(ctx, p); err != nil {
			return nil, err
		}
	}
	for _, name := range []string{"cases", "scorings"} {
		p := filepath.Join(path, name)
		entries, err := os.ReadDir(p)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if err := regularDirectory(p); err != nil {
			return nil, err
		}
		for _, entry := range entries {
			if strings.HasSuffix(entry.Name(), ".json") {
				if err := s.readFile(ctx, filepath.Join(p, entry.Name())); err != nil {
					return nil, err
				}
			}
		}
	}
	if len(s.bundle.Cases)+len(s.bundle.Scorings) == 0 {
		return nil, fmt.Errorf("no case or scoring documents in %s", path)
	}
	return s, nil
}

func regularDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("not a regular directory: %s", path)
	}
	return nil
}
func openRegular(path string) (*os.File, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("not a regular file: %s", path)
	}
	return os.Open(path)
}
func readLimited(path string, limit int64) ([]byte, error) {
	f, err := openRegular(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("%s exceeds %d bytes", path, limit)
	}
	return b, nil
}

func (s *source) readFile(ctx context.Context, path string) error {
	f, err := openRegular(path)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	s.bytes += info.Size()
	if s.bytes > MaxBundleBytes {
		return fmt.Errorf("bundle exceeds 4 GiB")
	}
	add := func(b []byte, where string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if len(b) > MaxDocumentBytes {
			return fmt.Errorf("%s exceeds 16 MiB", where)
		}
		v, err := decodeJSON(b)
		if err != nil {
			return fmt.Errorf("%s: %w", where, err)
		}
		m := object(v)
		if m == nil {
			return fmt.Errorf("%s: document must be an object", where)
		}
		// Schema validation is performed before any import is committed.
		switch str(m["schema"]) {
		case "detroit.case/v2":
			s.bundle.Cases = append(s.bundle.Cases, m)
		case "detroit.scoring/v2":
			s.bundle.Scorings = append(s.bundle.Scorings, m)
		case "detroit.dataset/v2":
			if s.bundle.Dataset != nil {
				return fmt.Errorf("multiple dataset documents")
			}
			s.bundle.Dataset = m
		default:
			return fmt.Errorf("%s: unsupported schema %q", where, m["schema"])
		}
		return nil
	}
	if strings.HasSuffix(path, ".jsonl") {
		scan := bufio.NewScanner(f)
		scan.Buffer(make([]byte, 4096), MaxDocumentBytes+2)
		line := 0
		for scan.Scan() {
			line++
			if len(strings.TrimSpace(scan.Text())) == 0 {
				continue
			}
			if err := add(scan.Bytes(), fmt.Sprintf("%s:%d", path, line)); err != nil {
				return err
			}
		}
		if err := scan.Err(); err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		return nil
	}
	b, err := io.ReadAll(io.LimitReader(f, MaxDocumentBytes+1))
	if err != nil {
		return err
	}
	return add(b, path)
}

// blobRefs visits only protocol blob fields, not arbitrary extension or JSON Schema data.
func blobRefs(b Bundle) []Document {
	var refs []Document
	materials := func(v any) {
		for _, x := range array(v) {
			if r := object(field(x, "blob")); r != nil {
				refs = append(refs, r)
			}
		}
	}
	for _, c := range b.Cases {
		materials(field(c, "task", "materials"))
		materials(field(c, "scoring", "materials"))
		for _, keys := range [][]string{{"task", "environment", "image", "build", "dockerfile"}, {"task", "environment", "image", "build", "context"}, {"diagnostic", "observed", "trajectory"}} {
			if r := object(field(c, keys...)); r != nil {
				refs = append(refs, r)
			}
		}
		for _, w := range array(field(c, "task", "environment", "workspaces")) {
			if r := object(field(w, "snapshot")); r != nil {
				refs = append(refs, r)
			}
		}
	}
	for _, s := range b.Scorings {
		materials(s["materials"])
	}
	return refs
}
