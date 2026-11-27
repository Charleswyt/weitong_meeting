// Package edgeaccess authenticates the access node independently of the meeting user.
package edgeaccess

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

const Node = "X-Weitong-Edge"
const stamp = "X-Weitong-Edge-Time"
const signature = "X-Weitong-Edge-Signature"

func Clear(h http.Header) { h.Del(Node); h.Del(stamp); h.Del(signature) }

func payload(r *http.Request, node, t string, body []byte) []byte {
	path := strings.TrimPrefix(r.URL.EscapedPath(), "/zwt-meeting")
	return []byte(fmt.Sprintf("wt-access-v1\n%s\n%s\n%s\n%s\n%x\n%x", node, t, r.Method, path, sha256.Sum256([]byte(r.Header.Get("Authorization"))), sha256.Sum256(body)))
}

func Sign(r *http.Request, node string, key ed25519.PrivateKey, body []byte) {
	t := strconv.FormatInt(time.Now().Unix(), 10)
	r.Header.Set(Node, node)
	r.Header.Set(stamp, t)
	r.Header.Set(signature, base64.RawStdEncoding.EncodeToString(ed25519.Sign(key, payload(r, node, t, body))))
}

// The key file contains only the public keys of enrolled boards and can be rotated live.
func Verify(r *http.Request, body []byte) (string, bool) {
	node := r.Header.Get(Node)
	if node == "" {
		return "", true
	}
	t := r.Header.Get(stamp)
	n, err := strconv.ParseInt(t, 10, 64)
	age := time.Now().Unix() - n
	if err != nil || age < -60 || age > 60 {
		return "", false
	}
	data, err := os.ReadFile(os.Getenv("WEITONG_EDGE_KEYS"))
	if err != nil {
		return "", false
	}
	var keys map[string]string
	if json.Unmarshal(data, &keys) != nil {
		return "", false
	}
	pub, err := base64.RawStdEncoding.DecodeString(keys[node])
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return "", false
	}
	sig, err := base64.RawStdEncoding.DecodeString(r.Header.Get(signature))
	return node, err == nil && ed25519.Verify(pub, payload(r, node, t, body), sig)
}
