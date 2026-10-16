package dataset

import (
	"encoding/json"
	"fmt"
	"sync"

	"github.com/Appletree24/Detroit/schemas"
	"github.com/google/jsonschema-go/jsonschema"
)

var schemaOnce sync.Once
var resolvedSchema *jsonschema.Resolved
var schemaError error

func validateDocument(d Document) error {
	schemaOnce.Do(func() {
		var s jsonschema.Schema
		schemaError = json.Unmarshal(schemas.DatasetV2, &s)
		if schemaError == nil {
			resolvedSchema, schemaError = s.Resolve(nil)
		}
	})
	if schemaError != nil {
		return fmt.Errorf("load v2 schema: %w", schemaError)
	}
	return resolvedSchema.Validate(d)
}
