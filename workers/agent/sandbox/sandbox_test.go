package sandbox

import (
	"slices"
	"strings"
	"testing"
)

func TestValidate(t *testing.T) {
	ok := Spec{Image: "python@sha256:abc"}
	ok.applyDefaults()
	if err := ok.validate(); err != nil {
		t.Fatalf("default spec: %v", err)
	}
	bad := map[string]Spec{
		"unpinned":       {Image: "python:3.11"},
		"no image":       {},
		"network":        {Image: "x@sha256:a", Network: "allowlist"},
		"root workspace": {Image: "x@sha256:a", Workspaces: []Workspace{{ID: "w", Path: "/"}}},
		"relative path":  {Image: "x@sha256:a", Workspaces: []Workspace{{ID: "w", Path: "work"}}},
		"unclean path":   {Image: "x@sha256:a", Workspaces: []Workspace{{ID: "w", Path: "/a/../b"}}},
		"under tmp":      {Image: "x@sha256:a", Workspaces: []Workspace{{ID: "w", Path: "/tmp/w"}}},
		"dup id":         {Image: "x@sha256:a", Workspaces: []Workspace{{ID: "w", Path: "/a"}, {ID: "w", Path: "/b"}}},
		"dup path":       {Image: "x@sha256:a", Workspaces: []Workspace{{ID: "a", Path: "/a"}, {ID: "b", Path: "/a"}}},
		"bad id":         {Image: "x@sha256:a", Workspaces: []Workspace{{ID: "../w", Path: "/a"}}},
		"negative":       {Image: "x@sha256:a", Resources: Resources{MemoryMB: -1}},
		"export name":    {Image: "x@sha256:a", ExportCommands: map[string]string{"a/b": "true"}},
	}
	for name, s := range bad {
		s.applyDefaults()
		if err := s.validate(); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
	dev := Spec{Image: "python:3.11", AllowUnpinned: true}
	dev.applyDefaults()
	if err := dev.validate(); err != nil {
		t.Errorf("AllowUnpinned: %v", err)
	}
}

func TestCreateArgsL1(t *testing.T) {
	s := Spec{Image: "img@sha256:a", Env: map[string]string{"B": "2", "A": "1"},
		Workspaces: []Workspace{{ID: "repo", Path: "/repo"}, {ID: "db", Path: "/var/lib/db"}}}
	s.applyDefaults()
	args := strings.Join((&Docker{Owner: "w1"}).createArgs(s, "n"), " ")
	for _, want := range []string{
		"--network none", "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges", "--init",
		"--memory 2048m", "--memory-swap 2048m", "--pids-limit 512", "--cpus 1",
		"--tmpfs /tmp:rw,exec,size=4096m", "--volume /repo", "--volume /var/lib/db",
		"--label detroit.owner=w1", "--env A=1 --env B=2", "--entrypoint sh img@sha256:a -c",
	} {
		if !strings.Contains(args, want) {
			t.Errorf("missing %q in %s", want, args)
		}
	}
	if strings.Contains(args, "--runtime") {
		t.Error("runtime must be omitted by default")
	}
	s.Network, s.WritableRoot, s.Runtime = NetworkHost, true, "runsc"
	args = strings.Join((&Docker{}).createArgs(s, "n"), " ")
	if !strings.Contains(args, "--network bridge") || strings.Contains(args, "--read-only") || !strings.Contains(args, "--runtime runsc") {
		t.Errorf("host network / writable root / gVisor: %s", args)
	}
}

func TestDiff(t *testing.T) {
	d := diff(map[string]string{"a": "1", "b": "2", "c": "3"}, map[string]string{"a": "1", "b": "9", "d": "4"})
	if !slices.Equal(d.Added, []string{"d"}) || !slices.Equal(d.Modified, []string{"b"}) || !slices.Equal(d.Deleted, []string{"c"}) {
		t.Fatalf("diff: %+v", d)
	}
}

func TestCapped(t *testing.T) {
	c := &capped{max: 5}
	c.Write([]byte("abc"))
	if c.truncated {
		t.Fatal("not yet truncated")
	}
	c.Write([]byte("de"))
	if c.truncated || c.buf.String() != "abcde" {
		t.Fatalf("exactly full: %q %v", c.buf.String(), c.truncated)
	}
	n, _ := c.Write([]byte("f"))
	if n != 1 || !c.truncated || c.buf.String() != "abcde" {
		t.Fatalf("overflow: %q %v", c.buf.String(), c.truncated)
	}
}
