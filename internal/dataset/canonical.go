package dataset

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// decodeJSON rejects duplicate keys and invalid Unicode instead of silently
// changing the document whose digest is being checked (RFC 8785 §3.1).
func decodeJSON(data []byte) (any, error) {
	if !utf8.Valid(data) {
		return nil, fmt.Errorf("invalid UTF-8")
	}
	// encoding/json replaces lone UTF-16 surrogates. Check escapes before decoding.
	for i := 0; i < len(data); i++ {
		if data[i] != '"' {
			continue
		}
		i++
		for ; i < len(data) && data[i] != '"'; i++ {
			if data[i] != '\\' {
				continue
			}
			i++
			if i >= len(data) || data[i] != 'u' {
				continue
			}
			if i+4 >= len(data) {
				return nil, fmt.Errorf("incomplete Unicode escape")
			}
			u, err := strconv.ParseUint(string(data[i+1:i+5]), 16, 16)
			if err != nil {
				return nil, err
			}
			i += 4
			if u >= 0xdc00 && u <= 0xdfff {
				return nil, fmt.Errorf("lone low surrogate")
			}
			if u >= 0xd800 && u <= 0xdbff {
				if i+6 >= len(data) || string(data[i+1:i+3]) != "\\u" {
					return nil, fmt.Errorf("lone high surrogate")
				}
				v, err := strconv.ParseUint(string(data[i+3:i+7]), 16, 16)
				if err != nil || v < 0xdc00 || v > 0xdfff {
					return nil, fmt.Errorf("invalid surrogate pair")
				}
				i += 6
			}
		}
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	var read func(int) (any, error)
	read = func(depth int) (any, error) {
		if depth > 1000 {
			return nil, fmt.Errorf("JSON nesting exceeds 1000")
		}
		t, err := dec.Token()
		if err != nil {
			return nil, err
		}
		switch t {
		case json.Delim('{'):
			obj := map[string]any{}
			for dec.More() {
				key, err := dec.Token()
				if err != nil {
					return nil, err
				}
				k := key.(string)
				if _, ok := obj[k]; ok {
					return nil, fmt.Errorf("duplicate key %q", k)
				}
				v, err := read(depth + 1)
				if err != nil {
					return nil, err
				}
				obj[k] = v
			}
			_, err = dec.Token()
			return obj, err
		case json.Delim('['):
			arr := []any{}
			for dec.More() {
				v, err := read(depth + 1)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			_, err = dec.Token()
			return arr, err
		default:
			if _, ok := t.(json.Delim); ok {
				return nil, fmt.Errorf("unexpected delimiter")
			}
			return t, nil
		}
	}
	v, err := read(0)
	if err != nil {
		return nil, err
	}
	if _, err = dec.Token(); err != io.EOF {
		return nil, fmt.Errorf("trailing JSON data")
	}
	return v, nil
}

// canonical uses UTF-16 property ordering and ECMAScript number formatting.
// Go's JSON number encoder uses the same shortest float64 representation;
// negative zero and U+2028/U+2029 require special handling.
func canonical(v any) ([]byte, error) {
	var out bytes.Buffer
	var write func(any) error
	write = func(v any) error {
		switch x := v.(type) {
		case map[string]any:
			keys := make([]string, 0, len(x))
			for k := range x {
				keys = append(keys, k)
			}
			slices.SortFunc(keys, func(a, b string) int { return slices.Compare(utf16.Encode([]rune(a)), utf16.Encode([]rune(b))) })
			out.WriteByte('{')
			for i, k := range keys {
				if i > 0 {
					out.WriteByte(',')
				}
				if err := write(k); err != nil {
					return err
				}
				out.WriteByte(':')
				if err := write(x[k]); err != nil {
					return err
				}
			}
			out.WriteByte('}')
		case []any:
			out.WriteByte('[')
			for i, item := range x {
				if i > 0 {
					out.WriteByte(',')
				}
				if err := write(item); err != nil {
					return err
				}
			}
			out.WriteByte(']')
		case string:
			// Serialize strings explicitly so literal backslash-u sequences remain intact.
			out.WriteByte('"')
			for _, r := range x {
				switch r {
				case '"', '\\':
					out.WriteByte('\\')
					out.WriteRune(r)
				case '\b':
					out.WriteString(`\b`)
				case '\t':
					out.WriteString(`\t`)
				case '\n':
					out.WriteString(`\n`)
				case '\f':
					out.WriteString(`\f`)
				case '\r':
					out.WriteString(`\r`)
				default:
					if r < 32 {
						fmt.Fprintf(&out, `\u%04x`, r)
					} else {
						out.WriteRune(r)
					}
				}
			}
			out.WriteByte('"')
		case float64:
			if x == 0 {
				out.WriteByte('0')
				break
			}
			b, err := json.Marshal(x)
			if err != nil {
				return err
			}
			out.Write(b)
		case nil, bool:
			b, _ := json.Marshal(x)
			out.Write(b)
		default:
			return fmt.Errorf("unsupported canonical JSON value %T", v)
		}
		return nil
	}
	if err := write(v); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func digest(v any) (string, error) {
	b, err := canonical(v)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}
func object(v any) map[string]any { m, _ := v.(map[string]any); return m }
func array(v any) []any           { a, _ := v.([]any); return a }
func str(v any) string            { s, _ := v.(string); return s }
func field(v any, keys ...string) any {
	for _, k := range keys {
		v = object(v)[k]
	}
	return v
}
func docKey(v any) string { return fmt.Sprintf("%s@%.0f", field(v, "id"), field(v, "revision")) }
func scoringDigest(v any) (string, error) {
	m := map[string]any{}
	for _, k := range []string{"combine", "requirements", "materials"} {
		if x, ok := object(v)[k]; ok {
			m[k] = x
		}
	}
	return digest(m)
}
func digestHex(d string) string { return strings.TrimPrefix(d, "sha256:") }
