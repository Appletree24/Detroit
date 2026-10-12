// Package stats 实现评测统计（docs/07 §2）。
package stats

import (
	"fmt"
	"math"
)

// Wilson 返回 n 次试验中 successes 次成功时，置信水平 confidence 下的 Wilson 得分区间（docs/07 §2.1）。
// n = 0 时区间为 [0, 1]：没有数据就没有任何结论。
func Wilson(successes, n int, confidence float64) ([2]float64, error) {
	if n < 0 || successes < 0 || successes > n {
		return [2]float64{}, fmt.Errorf("wilson: invalid successes=%d n=%d", successes, n)
	}
	if confidence <= 0 || confidence >= 1 {
		return [2]float64{}, fmt.Errorf("wilson: confidence %v must be in (0, 1)", confidence)
	}
	if n == 0 {
		return [2]float64{0, 1}, nil
	}
	z := normalQuantile(1 - (1-confidence)/2)
	fn := float64(n)
	p := float64(successes) / fn
	z2 := z * z
	denom := 1 + z2/fn
	center := (p + z2/(2*fn)) / denom
	half := z / denom * math.Sqrt(p*(1-p)/fn+z2/(4*fn*fn))
	return [2]float64{math.Max(0, center-half), math.Min(1, center+half)}, nil
}

// normalQuantile 是标准正态分布的分位数函数。
func normalQuantile(p float64) float64 {
	return math.Sqrt2 * math.Erfinv(2*p-1)
}
