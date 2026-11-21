package thirdparty

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSinosatForwardsVideoDelivery(t *testing.T) {
	requests := make(chan map[string]interface{}, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer owner" || r.URL.Path != "/rooms/1234567890/streams" {
			t.Errorf("unexpected media request %s", r.URL.Path)
		}
		var body struct {
			Settings map[string]interface{} `json:"settings"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		requests <- body.Settings
		_, _ = w.Write([]byte(`{"id":"test"}`))
	}))
	defer upstream.Close()
	t.Setenv("THIRDPARTY_CONFERENCE_BASEURL", upstream.URL)
	a := New()
	a.bindSinosatRoom("owner", "1234567890")
	defer a.unbindSinosatRoom("owner")
	for _, strategy := range []string{"source_frames", "bandwidth_first", "optimized"} {
		_, err := a.createPublicationSinosat(context.Background(), "owner", map[string]interface{}{
			"mediaKind": "camera", "transportMode": "cloud", "encodingStrategy": strategy,
			"width": 1920, "height": 1080, "fps": 25, "targetBitrateKbps": 100,
		})
		if err != nil {
			t.Fatal(err)
		}
		s := <-requests
		if s["mode"] != "cloud" || s["encodingStrategy"] != strategy || s["videoKbps"] != 100.0 || s["resolution"] != "1080p" || s["fps"] != 25.0 {
			t.Fatalf("%s: %#v", strategy, s)
		}
	}
	if _, err := a.createPublicationSinosat(context.Background(), "owner", map[string]interface{}{"mediaKind": "camera"}); err != nil {
		t.Fatal(err)
	}
	if s := <-requests; s["mode"] != "original" {
		t.Fatalf("legacy default: %#v", s)
	}
}

func TestSinosatVideoMeasurementsStaySeparateFromSettings(t *testing.T) {
	data := []byte(`{"streams":[{"id":"one","kind":"camera","settings":{"mode":"cloud","fps":60,"videoKbps":100},"metrics":{"sourceKbps":912.5,"outputKbps":86.3,"videoStats":{"captureFps":30,"publishFps":29,"cloudInputKbps":912.5,"cloudOutputKbps":86.3,"cloudInputFps":28.9,"cloudOutputFps":12.2}}},{"id":"two","kind":"screen","settings":{"mode":"cloud","fps":60,"videoKbps":100},"metrics":{"videoStats":{"captureFps":0}}}]}`)
	state, err := mapSinosatRoomSnapshot("http://localhost", "1234567890", data)
	if err != nil {
		t.Fatal(err)
	}
	p := state.Publications[0]
	if p.TargetBitrateKbps != 100 || p.SourceBitrateKbps() != 913 || p.FpsInt() != 12 || *p.VideoStats.CaptureFps != 30 {
		t.Fatalf("mixed source, output or target: %+v", p)
	}
	p = state.Publications[1]
	if p.FpsInt() != 0 || p.VideoStats.CloudOutputFps != nil || p.VideoStats.CaptureFps == nil || *p.VideoStats.CaptureFps != 0 {
		t.Fatal("lost missing versus zero semantics")
	}
}
