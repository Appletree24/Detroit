package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/Appletree24/Detroit/internal/dataset"
)

func datasetImport(args []string) error {
	fs := flag.NewFlagSet("dataset import", flag.ContinueOnError)
	path := fs.String("f", "", "v2 JSON/JSONL 文件或 bundle 目录")
	store := fs.String("store", ".detroit/datasets", "本地评测集快照目录")
	base := fs.String("base", "", "为单独评分提供题目的已有快照路径")
	confirm := fs.Bool("confirm-validation-conflicts", false, "确认验证集中的改进来源或同源题组冲突")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if *path == "" || len(pos) > 0 {
		return fmt.Errorf("usage: detroit dataset import -f <path> [--store DIR] [--base SNAPSHOT] [--confirm-validation-conflicts]")
	}
	result, err := dataset.Import(context.Background(), *path, dataset.Options{Store: *store, Base: *base, ConfirmValidationConflicts: *confirm})
	if err != nil {
		return err
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err = enc.Encode(result); err != nil {
		return err
	}
	if len(result.ValidationConflicts) > 0 && !*confirm {
		return fmt.Errorf("dataset saved for inspection; resolve conflicts or reimport with --confirm-validation-conflicts before running")
	}
	return nil
}
