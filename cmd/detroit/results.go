package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"text/tabwriter"

	"github.com/Appletree24/Detroit/internal/store"
)

func runResults(args []string) error {
	fs := flag.NewFlagSet("run results", flag.ContinueOnError)
	api := apiFlag(fs)
	asJSON := fs.Bool("json", false, "输出包含用量及制品路径的 JSON")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return fmt.Errorf("usage: detroit run results <run-id> [--json]")
	}
	var records []store.ResultRecord
	if err = call(http.MethodGet, *api+"/v1/runs/"+pos[0]+"/results", nil, &records); err != nil {
		return err
	}
	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(records)
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "TASK\tSTATUS\tOUTCOME\tERROR\tARTIFACTS")
	for _, r := range records {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", r.TaskID, r.Result.Status, r.Result.Outcome, r.Result.ErrorKind, r.Result.Artifacts)
	}
	return tw.Flush()
}
