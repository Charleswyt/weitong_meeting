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
