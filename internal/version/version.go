// Package version 给出写入 manifest 的 Detroit 版本。
package version

import "runtime/debug"

// String 返回 "git:<revision>"，工作区有未提交改动时追加 "-dirty"；无法确定时返回 "dev"。
func String() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "dev"
	}
	var rev, dirty string
	for _, s := range info.Settings {
		switch s.Key {
		case "vcs.revision":
			rev = s.Value
		case "vcs.modified":
			if s.Value == "true" {
				dirty = "-dirty"
			}
		}
	}
	if rev == "" {
		return "dev"
	}
	if len(rev) > 12 {
		rev = rev[:12]
	}
	return "git:" + rev + dirty
}
