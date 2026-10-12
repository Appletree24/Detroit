// detroit 是命令行入口：提交 run、查看进度、取消；以及启动 mock Worker。
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	workerv1 "github.com/Appletree24/Detroit/gen/detroit/worker/v1"
	"github.com/Appletree24/Detroit/internal/core"
	"github.com/Appletree24/Detroit/internal/store"
	"github.com/Appletree24/Detroit/internal/workerkit"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

const usage = `usage:
  detroit run submit -f <runspec.yaml> [--api URL]
  detroit run list [--api URL]
  detroit run status <run-id> [--api URL] [--json]
  detroit run cancel <run-id> [--api URL]
  detroit worker mock [--controller ADDR] [--slots N] [--success-rate P] [--unknown-rate P] [--crash-rate P] [--delay D]
`

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		return fmt.Errorf("missing command")
	}
	switch args[0] + " " + args[1] {
	case "run submit":
		return runSubmit(args[2:])
	case "run list":
		return runList(args[2:])
	case "run status":
		return runStatus(args[2:])
	case "run cancel":
		return runCancel(args[2:])
	case "worker mock":
		return workerMock(args[2:])
	}
	fmt.Fprint(os.Stderr, usage)
	return fmt.Errorf("unknown command %q", strings.Join(args[:2], " "))
}

func apiFlag(fs *flag.FlagSet) *string {
	def := os.Getenv("DETROIT_API")
	if def == "" {
		def = "http://127.0.0.1:7071"
	}
	return fs.String("api", def, "控制面 API 地址（环境变量 DETROIT_API）")
}

// parse 允许位置参数和选项交错，如 `status <id> --json`。
func parse(fs *flag.FlagSet, args []string) ([]string, error) {
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		args = fs.Args()
		if len(args) == 0 {
			return pos, nil
		}
		pos = append(pos, args[0])
		args = args[1:]
	}
}

func runSubmit(args []string) error {
	fs := flag.NewFlagSet("run submit", flag.ExitOnError)
	file := fs.String("f", "", "RunSpec 文件")
	api := apiFlag(fs)
	if _, err := parse(fs, args); err != nil {
		return err
	}
	if *file == "" {
		return fmt.Errorf("-f is required")
	}
	body, err := os.ReadFile(*file)
	if err != nil {
		return err
	}
	var res store.SubmitResult
	if err := call(http.MethodPost, *api+"/v1/runs", body, &res); err != nil {
		return err
	}
	if res.Existing {
		fmt.Printf("resumed %s: %d episodes (%d added)\n", res.RunID, res.Total, res.Added)
	} else {
		fmt.Printf("submitted %s: %d episodes\n", res.RunID, res.Total)
	}
	return nil
}

func runList(args []string) error {
	fs := flag.NewFlagSet("run list", flag.ExitOnError)
	api := apiFlag(fs)
	if _, err := parse(fs, args); err != nil {
		return err
	}
	var runs []store.RunSummary
	if err := call(http.MethodGet, *api+"/v1/runs", nil, &runs); err != nil {
		return err
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "RUN\tSTATUS\tCREATED")
	for _, r := range runs {
		fmt.Fprintf(tw, "%s\t%s\t%s\n", r.RunID, r.Status, r.CreatedAt.Local().Format(time.DateTime))
	}
	return tw.Flush()
}

func runStatus(args []string) error {
	fs := flag.NewFlagSet("run status", flag.ExitOnError)
	api := apiFlag(fs)
	asJSON := fs.Bool("json", false, "输出 JSON")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return fmt.Errorf("usage: detroit run status <run-id>")
	}
	var raw json.RawMessage
	if err := call(http.MethodGet, *api+"/v1/runs/"+pos[0], nil, &raw); err != nil {
		return err
	}
	if *asJSON {
		_, err := os.Stdout.Write(append(raw, '\n'))
		return err
	}
	var s store.RunSummary
	if err := json.Unmarshal(raw, &s); err != nil {
		return err
	}
	total := 0
	for _, n := range s.Episodes {
		total += n
	}
	fmt.Printf("run %s  status=%s  episodes=%d  pending=%d leased=%d done=%d infra_error=%d\n",
		s.RunID, s.Status, total, s.Episodes["pending"], s.Episodes["leased"], s.Episodes["done"], s.Episodes["infra_error"])
	tw := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "GROUP\tN\tSUCCESS\tRATE\t95% CI\tUNKNOWN\tINFRA_ERROR")
	row := func(name string, a core.Aggregate) {
		fmt.Fprintf(tw, "%s\t%d\t%d\t%.3f\t[%.3f, %.3f]\t%d\t%d\n", name, a.N, a.Successes, a.Rate, a.CI95[0], a.CI95[1], a.Unknowns, a.InfraErrors)
	}
	row("overall", s.Overall)
	for _, v := range s.ByVariant {
		row(strings.Join(v.GroupBy, ","), v)
	}
	if err := tw.Flush(); err != nil {
		return err
	}
	for kind, n := range s.ErrorKinds {
		fmt.Printf("infra_error %s: %d\n", kind, n)
	}
	return nil
}

func runCancel(args []string) error {
	fs := flag.NewFlagSet("run cancel", flag.ExitOnError)
	api := apiFlag(fs)
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return fmt.Errorf("usage: detroit run cancel <run-id>")
	}
	var res map[string]string
	if err := call(http.MethodPost, *api+"/v1/runs/"+pos[0]+"/cancel", nil, &res); err != nil {
		return err
	}
	fmt.Printf("run %s: %s\n", res["run_id"], res["status"])
	return nil
}

func workerMock(args []string) error {
	fs := flag.NewFlagSet("worker mock", flag.ExitOnError)
	addr := fs.String("controller", "127.0.0.1:7070", "控制面 gRPC 地址")
	id := fs.String("id", "", "Worker ID（默认 mock-<hostname>-<pid>）")
	vertical := fs.String("vertical", "agent", "垂类")
	slots := fs.Int("slots", 4, "并行度")
	m := &workerkit.Mock{}
	fs.Float64Var(&m.SuccessRate, "success-rate", 0.7, "有效结果中成功的比例（被 subject.params.success_rate 覆盖）")
	fs.Float64Var(&m.UnknownRate, "unknown-rate", 0, "判为 unknown 的比例")
	fs.Float64Var(&m.CrashRate, "crash-rate", 0, "每次执行模拟崩溃的概率")
	fs.DurationVar(&m.Delay, "delay", 100*time.Millisecond, "每个 episode 的执行时长")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	if *id == "" {
		host, _ := os.Hostname()
		*id = fmt.Sprintf("mock-%s-%d", host, os.Getpid())
	}
	conn, err := grpc.NewClient(*addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return err
	}
	defer conn.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	fmt.Fprintf(os.Stderr, "mock worker %s → %s (vertical=%s slots=%d)\n", *id, *addr, *vertical, *slots)
	return workerkit.Run(ctx, workerv1.NewSchedulerClient(conn), workerkit.Config{
		WorkerID: *id, Vertical: *vertical, Slots: *slots, Labels: map[string]string{"executor": "mock"},
	}, m)
}

func call(method, url string, body []byte, out any) error {
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, url, r)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		var e struct{ Error string }
		if json.Unmarshal(data, &e) == nil && e.Error != "" {
			return fmt.Errorf("%s: %s", resp.Status, e.Error)
		}
		return fmt.Errorf("%s: %s", resp.Status, strings.TrimSpace(string(data)))
	}
	return json.Unmarshal(data, out)
}
