// Package schemas embeds the exchange schema so validation does not depend on
// the working directory or network access.
package schemas

import _ "embed"

//go:embed detroit-v2.schema.json
var DatasetV2 []byte
