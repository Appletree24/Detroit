package stats

import (
	"math"
	"testing"
)

func TestWilson(t *testing.T) {
	// 参考值通过二分法直接反解得分检验 |p̂−p| = z·sqrt(p(1−p)/n) 得到，与闭式公式相互独立。
	cases := []struct {
		s, n   int
		lo, hi float64
	}{
		{5, 10, 0.2366, 0.7634},
		{50, 100, 0.4038, 0.5962},
		{0, 10, 0, 0.2775},
		{10, 10, 0.7225, 1},
		{1, 20, 0.0089, 0.2361},
	}
	for _, c := range cases {
		ci, err := Wilson(c.s, c.n, 0.95)
		if err != nil {
			t.Fatal(err)
		}
		if math.Abs(ci[0]-c.lo) > 5e-4 || math.Abs(ci[1]-c.hi) > 5e-4 {
			t.Errorf("Wilson(%d,%d) = %v, want [%v %v]", c.s, c.n, ci, c.lo, c.hi)
		}
	}
	if ci, _ := Wilson(0, 0, 0.95); ci != [2]float64{0, 1} {
		t.Errorf("n=0: %v", ci)
	}
	for _, bad := range [][2]int{{-1, 3}, {4, 3}} {
		if _, err := Wilson(bad[0], bad[1], 0.95); err == nil {
			t.Errorf("%v: expected error", bad)
		}
	}
	if _, err := Wilson(1, 2, 1); err == nil {
		t.Error("confidence 1: expected error")
	}
}
