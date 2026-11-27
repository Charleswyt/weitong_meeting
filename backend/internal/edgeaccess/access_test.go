package edgeaccess

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestBoardProofBindsUserRouteAndBody(t *testing.T) {
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(t.TempDir(), "enrolled.json")
	keys, _ := json.Marshal(map[string]string{"lab": base64.RawStdEncoding.EncodeToString(pub)})
	if err := os.WriteFile(filename, keys, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WEITONG_EDGE_KEYS", filename)
	req := httptest.NewRequest("POST", "/zwt-meeting/api/v1/meetings/join", nil)
	req.Header.Set("Authorization", "Bearer first")
	body := []byte(`{"meetingNo":"12345678"}`)
	Sign(req, "lab", key, body)
	req.URL.Path = "/api/v1/meetings/join"
	if name, ok := Verify(req, body); !ok || name != "lab" {
		t.Fatal("board origin lost at reverse proxy")
	}
	if _, ok := Verify(req, nil); ok {
		t.Fatal("body substitution accepted")
	}
	req.Header.Set("Authorization", "Bearer second")
	if _, ok := Verify(req, body); ok {
		t.Fatal("user substitution accepted")
	}
	req.Header.Set("Authorization", "Bearer first")
	req.URL.Path = "/api/v1/meetings/end"
	if _, ok := Verify(req, body); ok {
		t.Fatal("unexpected route accepted")
	}
}
