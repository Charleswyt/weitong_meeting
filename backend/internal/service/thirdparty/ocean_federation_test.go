package thirdparty

import (
	"encoding/json"
	"testing"
)

func TestNativeMediaOffersEarlyWHEPAndPreservesCompressedRoute(t *testing.T) {
	var p Publication
	if err := json.Unmarshal([]byte(`{"hdWhepUrl":"/camera/whep","hdReady":true}`), &p); err != nil {
		t.Fatal(err)
	}
	if !p.HdReady || p.BrowserWHEP() != "/camera/whep" {
		t.Fatal("native response lost its receive leg")
	}
	p.HdReady = false
	if p.BrowserWHEP() == "" {
		t.Fatal("compact snapshot must offer negotiation before first frame")
	}
	p.DirectVideoUrl = "/video"
	if p.BrowserWHEP() != "" {
		t.Fatal("direct compressed route displaced")
	}
}
