package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/Appletree24/Detroit/internal/core"
)

func TestAdapterLeasesAndAcceptedArtifactResults(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "d.db"))
	real := testSpec(t)
	real.Name = "real"
	real.Subject.Adapter = "openai-compatible"
	realEpisodes := episodes(real, 1)
	mock := testSpec(t)
	mock.Name = "mock"
	mockEpisodes := episodes(mock, 1)
	for _, item := range []struct {
		spec *core.RunSpec
		eps  []core.Episode
	}{{real, realEpisodes}, {mock, mockEpisodes}} {
		if _, err := st.Submit(ctx, item.spec, nil, nil, item.eps, t0); err != nil {
			t.Fatal(err)
		}
	}
	for _, item := range []struct {
		adapter string
		want    string
	}{{"mock", mock.RunID()}, {"openai-compatible", real.RunID()}} {
		leased, err := st.LeaseForAdapter(ctx, item.adapter, "agent", item.adapter, 10, t0, time.Minute)
		if err != nil || len(leased) != 1 || leased[0].Episode.RunID != item.want {
			t.Fatalf("%s: %+v %v", item.adapter, leased, err)
		}
	}
	result := done(realEpisodes[0].Key, core.OutcomeSuccess)
	result.Artifacts = "/accepted"
	result.Cost.InputTokens = 12
	if _, err := st.Report(ctx, result, "", t0); err != nil {
		t.Fatal(err)
	}
	result.Artifacts = "/later"
	if ack, err := st.Report(ctx, result, "", t0); err != nil || !ack.Duplicate {
		t.Fatalf("%+v %v", ack, err)
	}
	records, err := st.Results(ctx, real.RunID())
	if err != nil || len(records) != 1 || records[0].Result.Artifacts != "/accepted" || records[0].Result.Cost.InputTokens != 12 {
		t.Fatalf("%+v %v", records, err)
	}
	if _, err = st.Results(ctx, "absent"); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
}
