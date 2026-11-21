package websocket

import (
	"cloud-conference-backend/internal/service/thirdparty"
	"testing"
)

func TestReadyToReadyRenditionSwitchIsBroadcast(t *testing.T) {
	before := thirdparty.Publication{PublicationId: "camera", Status: "ready", TransportMode: "cloud", Revision: 4, EncodingStrategy: "optimized"}
	after := before
	after.Revision++
	after.TransportMode = "original"
	after.EncodingStrategy = ""
	if !diffPublications([]thirdparty.Publication{before}, []thirdparty.Publication{after}) {
		t.Fatal("a receiving browser must reconnect even when both snapshots are ready")
	}
	if diffPublications([]thirdparty.Publication{after}, []thirdparty.Publication{after}) {
		t.Fatal("identical settings must not reopen a connection")
	}
}
