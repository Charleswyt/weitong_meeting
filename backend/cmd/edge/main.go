// Standalone HTTPS entrance for a board. The cloud retains the account and the room.
package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"html"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"cloud-conference-backend/internal/edgeaccess"
)

const mount = "/zwt-meeting"
const limit = 128 << 10

var publishPath = regexp.MustCompile(`^/zwt-meeting/api/v1/meetings/(-?[0-9]+)/publications(?:/([a-zA-Z0-9_-]{1,80})/(whip|stop))?$`)

type config struct{ Listen, Origin, CloudCert, TLSCert, TLSKey, Identity, Node, Dist, Media, Binaries, Uplink string }
type video struct {
	MediaKind                             string
	Width, Height, Fps, TargetBitrateKbps int
}
type publication struct {
	owner   [32]byte
	media   video
	expires time.Time
	cancel  context.CancelFunc
}
type gateway struct {
	cfg    config
	key    ed25519.PrivateKey
	target *url.URL
	client *http.Client
	proxy  *httputil.ReverseProxy
	mu     sync.Mutex
	pubs   map[string]*publication
}

func check(e error) {
	if e != nil {
		log.Fatal(e)
	}
}
func readConfig(file string) config {
	data, e := os.ReadFile(file)
	check(e)
	var c config
	check(json.Unmarshal(data, &c))
	return c
}
func readSeed(file string) ed25519.PrivateKey {
	b, e := os.ReadFile(file)
	check(e)
	b, e = base64.RawStdEncoding.DecodeString(strings.TrimSpace(string(b)))
	check(e)
	if len(b) != ed25519.SeedSize {
		log.Fatal("invalid board identity")
	}
	return ed25519.NewKeyFromSeed(b)
}

func upstreamTransport(certFile string) (*http.Transport, error) {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.Proxy = nil
	t.ResponseHeaderTimeout = 30 * time.Second
	if certFile == "" {
		return t, nil
	}
	data, e := os.ReadFile(certFile)
	if e != nil {
		return nil, e
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, errors.New("invalid cloud certificate")
	}
	pin, e := x509.ParseCertificate(block.Bytes)
	if e != nil {
		return nil, e
	}
	// The deployed cloud certificate is self-signed and uses an IP in its CN. Pin its exact DER.
	t.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: true, VerifyConnection: func(s tls.ConnectionState) error {
		now := time.Now()
		if len(s.PeerCertificates) == 0 || !s.PeerCertificates[0].Equal(pin) || now.Before(pin.NotBefore) || now.After(pin.NotAfter) {
			return errors.New("cloud certificate does not match enrollment")
		}
		return nil
	}}
	return t, nil
}

func limited(r io.Reader, n int64) ([]byte, error) {
	b, e := io.ReadAll(io.LimitReader(r, n+1))
	if int64(len(b)) > n {
		return nil, errors.New("request too large")
	}
	return b, e
}
func (g *gateway) upstream(ctx context.Context, method, p string, auth, kind string, data []byte) (*http.Response, error) {
	u := *g.target
	u.Path = p
	req, e := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(data))
	if e != nil {
		return nil, e
	}
	req.Header.Set("Authorization", auth)
	req.Header.Set("Content-Type", kind)
	return g.client.Do(req)
}
func respond(w http.ResponseWriter, res *http.Response, b []byte) {
	w.Header().Set("Content-Type", res.Header.Get("Content-Type"))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(res.StatusCode)
	_, _ = w.Write(b)
}

func (g *gateway) create(w http.ResponseWriter, r *http.Request) {
	auth := r.Header.Get("Authorization")
	body, e := limited(r.Body, limit)
	if e != nil {
		http.Error(w, "invalid publication", 400)
		return
	}
	var v video
	if json.Unmarshal(body, &v) != nil {
		http.Error(w, "invalid publication", 400)
		return
	}
	if v.MediaKind == "camera" || v.MediaKind == "screen" {
		var fields map[string]json.RawMessage
		if json.Unmarshal(body, &fields) != nil || fields == nil {
			http.Error(w, "invalid video configuration", 400)
			return
		}
		fields["transportMode"] = json.RawMessage(`"original"`)
		delete(fields, "encodingStrategy")
		body, e = json.Marshal(fields)
		if e != nil {
			http.Error(w, "invalid video configuration", 400)
			return
		}
	}
	res, e := g.upstream(r.Context(), "POST", r.URL.Path, auth, "application/json", body)
	if e != nil {
		http.Error(w, "cloud publication unavailable", 502)
		return
	}
	defer res.Body.Close()
	b, e := limited(res.Body, limit)
	if e != nil {
		http.Error(w, "invalid cloud response", 502)
		return
	}
	var ack struct {
		Code int
		Data struct{ PublicationId string }
	}
	if json.Unmarshal(b, &ack) == nil && ack.Code == 200 && ack.Data.PublicationId != "" {
		id := r.URL.Path + "/" + ack.Data.PublicationId
		if !publishPath.MatchString(id + "/whip") {
			http.Error(w, "invalid publication ID", 502)
			return
		}
		g.mu.Lock()
		g.pubs[id] = &publication{owner: sha256.Sum256([]byte(auth)), media: v, expires: time.Now().Add(2 * time.Minute)}
		g.mu.Unlock()
		if v.MediaKind == "camera" || v.MediaKind == "screen" {
			var reply map[string]any
			if json.Unmarshal(b, &reply) == nil {
				if d, ok := reply["data"].(map[string]any); ok {
					d["sourceType"] = "rk_browser_roi"
					b, _ = json.Marshal(reply)
				}
			}
		}
	}
	respond(w, res, b)
}

func (g *gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self)")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	p := r.URL.Path
	if origin := r.Header.Get("Origin"); origin != "" && origin != "https://"+r.Host {
		http.Error(w, "origin denied", 403)
		return
	}
	if p == "/" || p == mount {
		http.Redirect(w, r, mount+"/", http.StatusTemporaryRedirect)
		return
	}
	if !strings.HasPrefix(p, mount+"/") || p != path.Clean(p) && !strings.HasSuffix(p, "/") || strings.Contains(p, "..") {
		http.NotFound(w, r)
		return
	}
	edgeaccess.Clear(r.Header)
	if m := publishPath.FindStringSubmatch(p); m != nil {
		if m[2] == "" && r.Method == "POST" {
			g.create(w, r)
			return
		}
		if m[2] != "" {
			key := strings.TrimSuffix(p, "/"+m[3])
			owner := sha256.Sum256([]byte(r.Header.Get("Authorization")))
			g.mu.Lock()
			pub := g.pubs[key]
			owns := pub != nil && pub.owner == owner
			if owns && (m[3] == "stop" && r.Method == "POST" || m[3] == "whip" && r.Method == "DELETE") {
				if pub.cancel != nil {
					pub.cancel()
				}
				if m[3] == "stop" {
					delete(g.pubs, key)
				}
			}
			g.mu.Unlock()
			if m[3] == "whip" && r.Method == "POST" {
				if !owns {
					http.Error(w, "请重新开启该媒体", 403)
					return
				}
				if pub.media.MediaKind != "audio" {
					g.start(w, r, key, pub)
					return
				}
			}
		}
	}
	if p == mount+"/api/v1/meetings/join" && r.Method == "POST" || p == mount+"/api/v1/settings/capabilities" && r.Method == "GET" {
		var body []byte
		if r.Method == "POST" {
			var e error
			body, e = limited(r.Body, limit)
			if e != nil {
				http.Error(w, "invalid join", 400)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
		}
		edgeaccess.Sign(r, g.cfg.Node, g.key, body)
	}
	if strings.HasPrefix(p, mount+"/api/") || strings.HasPrefix(p, mount+"/ws/") || strings.HasPrefix(p, mount+"/assist/") || p == mount+"/assets/media-player.js" {
		g.proxy.ServeHTTP(w, r)
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		http.Error(w, "method unavailable", 405)
		return
	}
	rel := strings.TrimPrefix(p, mount+"/")
	f := filepath.Join(g.cfg.Dist, filepath.FromSlash(rel))
	if rel == "" || !strings.Contains(path.Base(rel), ".") {
		f = filepath.Join(g.cfg.Dist, "index.html")
	}
	if strings.HasSuffix(f, ".map") {
		http.NotFound(w, r)
		return
	}
	if strings.Contains(p, "/assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	ff, e := os.Open(f)
	if e != nil {
		http.NotFound(w, r)
		return
	}
	defer ff.Close()
	fi, e := ff.Stat()
	if e != nil || !fi.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	if fi.Name() == "index.html" {
		b, err := limited(ff, 256<<10)
		if err != nil {
			http.Error(w, "invalid index", 500)
			return
		}
		meta := `<meta name="weitong-public-origin" content="` + html.EscapeString(g.cfg.Origin) + `">`
		b = bytes.Replace(b, []byte("<head>"), []byte("<head>"+meta), 1)
		http.ServeContent(w, r, fi.Name(), fi.ModTime(), bytes.NewReader(b))
		return
	}
	http.ServeContent(w, r, fi.Name(), fi.ModTime(), ff)
}

func main() {
	conf := flag.String("config", "/etc/weitong-edge/config.json", "board configuration")
	gen := flag.String("generate-key", "", "create a new board identity and print its public key")
	flag.Parse()
	if *gen != "" {
		pub, priv, e := ed25519.GenerateKey(rand.Reader)
		check(e)
		f, e := os.OpenFile(*gen, os.O_EXCL|os.O_CREATE|os.O_WRONLY, 0600)
		check(e)
		_, e = fmt.Fprintln(f, base64.RawStdEncoding.EncodeToString(priv.Seed()))
		check(e)
		check(f.Close())
		fmt.Println(base64.RawStdEncoding.EncodeToString(pub))
		return
	}
	c := readConfig(*conf)
	u, e := url.Parse(c.Origin)
	check(e)
	if u.Scheme != "https" || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.User != nil || c.Node == "" {
		log.Fatal("invalid cloud origin or board ID")
	}
	m, e := url.Parse(c.Media)
	check(e)
	if m.Scheme != "http" || !net.ParseIP(m.Hostname()).IsLoopback() || m.Path != "" {
		log.Fatal("expected a loopback media service")
	}
	tr, e := upstreamTransport(c.CloudCert)
	check(e)
	g := &gateway{cfg: c, key: readSeed(c.Identity), target: u, client: &http.Client{Transport: tr, Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, pubs: map[string]*publication{}}
	g.proxy = httputil.NewSingleHostReverseProxy(u)
	g.proxy.Transport = tr
	director := g.proxy.Director
	g.proxy.Director = func(r *http.Request) {
		director(r)
		r.Host = u.Host
		if r.Header.Get("Origin") != "" {
			r.Header.Set("Origin", c.Origin)
		}
		r.Header.Del("X-Forwarded-For")
		r.Header.Del("Forwarded")
		r.Header.Del("X-Forwarded-Host")
		r.Header.Del("X-Forwarded-Proto")
	}
	go func() {
		for range time.Tick(time.Minute) {
			g.mu.Lock()
			for k, p := range g.pubs {
				if p.cancel == nil && time.Now().After(p.expires) {
					delete(g.pubs, k)
				}
			}
			g.mu.Unlock()
		}
	}()
	srv := &http.Server{Addr: c.Listen, Handler: g, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second}
	check(srv.ListenAndServeTLS(c.TLSCert, c.TLSKey))
}
