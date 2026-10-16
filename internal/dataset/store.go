package dataset

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
)

type snapshot struct {
	Bundle              Bundle `json:"bundle"`
	ValidationConfirmed bool   `json:"validation_confirmed"`
}

func snapshotValue(s snapshot) (Document, error) {
	b, err := json.Marshal(s)
	if err != nil {
		return nil, err
	}
	v, err := decodeJSON(b)
	return object(v), err
}
func snapshotDigest(s snapshot) (string, error) {
	v, err := snapshotValue(s)
	if err != nil {
		return "", err
	}
	return digest(v)
}

func blobPath(root, hex string) string { return filepath.Join(root, "blobs", "sha256", hex) }
func verifyBlob(ctx context.Context, root string, ref Document, dst string) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	hexDigest := str(ref["sha256"])
	raw, err := hex.DecodeString(hexDigest)
	if err != nil || len(raw) != 32 || hex.EncodeToString(raw) != hexDigest {
		return 0, fmt.Errorf("invalid blob digest %q", hexDigest)
	}
	for _, p := range []string{filepath.Join(root, "blobs"), filepath.Join(root, "blobs", "sha256")} {
		if err := regularDirectory(p); err != nil {
			return 0, err
		}
	}
	f, err := openRegular(blobPath(root, hexDigest))
	if err != nil {
		return 0, err
	}
	defer f.Close()
	var target io.Writer = io.Discard
	if dst != "" {
		if err = os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return 0, err
		}
		out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err != nil {
			return 0, err
		}
		defer out.Close()
		target = out
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(h, target), io.LimitReader(f, MaxBlobBytes+1))
	if err != nil {
		return n, err
	}
	if err := ctx.Err(); err != nil {
		return n, err
	}
	if n > MaxBlobBytes {
		return n, fmt.Errorf("blob %s exceeds 256 MiB", hexDigest)
	}
	if float64(n) != ref["bytes"] || hex.EncodeToString(h.Sum(nil)) != hexDigest {
		return n, fmt.Errorf("blob %s: size or digest mismatch", hexDigest)
	}
	return n, nil
}

// Open verifies the snapshot identity and every referenced blob before returning
// content. expected pins a RunSpec to immutable input rather than a mutable path.
func Open(ctx context.Context, path, expected string) (Bundle, error) {
	snap, err := openSnapshot(ctx, path, expected)
	return snap.Bundle, err
}

func openSnapshot(ctx context.Context, path, expected string) (snapshot, error) {
	b, err := readLimited(filepath.Join(path, "snapshot.json"), MaxBundleBytes)
	if err != nil {
		return snapshot{}, err
	}
	v, err := decodeJSON(b)
	if err != nil {
		return snapshot{}, err
	}
	got, err := digest(v)
	if err != nil {
		return snapshot{}, err
	}
	if expected == "" {
		expected = "sha256:" + filepath.Base(filepath.Clean(path))
	}
	if got != expected {
		return snapshot{}, fmt.Errorf("snapshot digest mismatch: got %s want %s", got, expected)
	}
	var s snapshot
	if err = json.Unmarshal(b, &s); err != nil {
		return snapshot{}, err
	}
	if s.Bundle.Dataset == nil {
		return snapshot{}, fmt.Errorf("snapshot has no dataset")
	}
	seen := map[string]bool{}
	total := int64(len(b))
	for _, ref := range blobRefs(s.Bundle) {
		hex := str(ref["sha256"])
		if seen[hex] {
			continue
		}
		seen[hex] = true
		n, err := verifyBlob(ctx, path, ref, "")
		if err != nil {
			return snapshot{}, err
		}
		total += n
		if total > MaxBundleBytes {
			return snapshot{}, fmt.Errorf("bundle exceeds 4 GiB")
		}
	}
	return s, ctx.Err()
}

func save(ctx context.Context, s snapshot, store string, roots []string) (string, string, error) {
	sum, err := snapshotDigest(s)
	if err != nil {
		return "", "", err
	}
	if store == "" {
		store = ".detroit/datasets"
	}
	store, err = filepath.Abs(store)
	if err != nil {
		return "", "", err
	}
	if err = os.MkdirAll(store, 0o755); err != nil {
		return "", "", err
	}
	target := filepath.Join(store, digestHex(sum))
	if _, err := os.Stat(target); err == nil {
		_, err = Open(ctx, target, sum)
		return target, sum, err
	} else if !os.IsNotExist(err) {
		return "", "", err
	}
	temp, err := os.MkdirTemp(store, ".import-")
	if err != nil {
		return "", "", err
	}
	defer os.RemoveAll(temp)
	seen := map[string]bool{}
	total := int64(0)
	for _, ref := range blobRefs(s.Bundle) {
		hex := str(ref["sha256"])
		if seen[hex] {
			continue
		}
		seen[hex] = true
		root := ""
		for _, candidate := range roots {
			if _, err := os.Lstat(blobPath(candidate, hex)); err == nil {
				root = candidate
				break
			}
		}
		if root == "" {
			return "", "", fmt.Errorf("missing blob %s", hex)
		}
		n, err := verifyBlob(ctx, root, ref, blobPath(temp, hex))
		if err != nil {
			return "", "", err
		}
		total += n
		if total > MaxBundleBytes {
			return "", "", fmt.Errorf("bundle exceeds 4 GiB")
		}
	}
	b, err := json.Marshal(s)
	if err != nil {
		return "", "", err
	}
	total += int64(len(b))
	if total > MaxBundleBytes {
		return "", "", fmt.Errorf("bundle exceeds 4 GiB")
	}
	if err = os.WriteFile(filepath.Join(temp, "snapshot.json"), b, 0o644); err != nil {
		return "", "", err
	}
	if err = ctx.Err(); err != nil {
		return "", "", err
	}
	if err = os.Rename(temp, target); err != nil {
		if _, check := Open(ctx, target, sum); check != nil {
			return "", "", err
		}
	}
	return target, sum, nil
}

// stableOrder makes imports independent of filesystem traversal order.
func stableOrder(b *Bundle) {
	sort.Slice(b.Cases, func(i, j int) bool { return docKey(b.Cases[i]) < docKey(b.Cases[j]) })
	sort.Slice(b.Scorings, func(i, j int) bool { return docKey(b.Scorings[i]) < docKey(b.Scorings[j]) })
}
