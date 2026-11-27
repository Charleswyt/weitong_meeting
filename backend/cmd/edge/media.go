package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var local = &http.Client{Timeout: 20 * time.Second, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func nonce() string {
	var b [20]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func bounded(value, def, low, high int) int {
	if value < low {
		return def
	}
	return min(value, high)
}

func (g *gateway) start(w http.ResponseWriter, r *http.Request, key string, p *publication) {
	offer, e := limited(r.Body, limit)
	if e != nil || !bytes.Contains(offer, []byte("m=video ")) {
		http.Error(w, "invalid video offer", 400)
		return
	}
	if p.media.Width > 4096 || p.media.Height > 4096 {
		http.Error(w, "画幅超出板卡范围", 422)
		return
	}
	ctx, stop := context.WithCancel(context.Background())
	g.mu.Lock()
	if g.pubs[key] != p || p.cancel != nil || time.Now().After(p.expires) {
		g.mu.Unlock()
		stop()
		http.Error(w, "请重新开启该媒体", 409)
		return
	}
	p.cancel = stop
	g.mu.Unlock()
	finished := func() {
		stop()
		g.mu.Lock()
		if g.pubs[key] == p {
			delete(g.pubs, key)
		}
		g.mu.Unlock()
	}
	name := "conference_input/wt_" + nonce()
	req, e := http.NewRequestWithContext(r.Context(), "POST", g.cfg.Media+"/"+name+"/whip", bytes.NewReader(offer))
	if e != nil {
		finished()
		http.Error(w, "invalid local media endpoint", 500)
		return
	}
	req.Header.Set("Content-Type", "application/sdp")
	res, e := local.Do(req)
	if e != nil {
		finished()
		log.Printf("local WHIP failed: %v", e)
		http.Error(w, "板卡媒体服务不可用", 502)
		return
	}
	defer res.Body.Close()
	answer, e := limited(res.Body, limit)
	if e != nil || res.StatusCode/100 != 2 || !bytes.Contains(answer, []byte("m=video ")) {
		finished()
		http.Error(w, "板卡未接受视频编码，请使用 H.264", 502)
		return
	}
	loc, e := res.Location()
	base, _ := url.Parse(g.cfg.Media)
	if e != nil || loc.Host != base.Host || loc.Scheme != base.Scheme || !strings.HasPrefix(loc.Path, "/"+name+"/") {
		finished()
		http.Error(w, "invalid local session", 502)
		return
	}
	auth := r.Header.Get("Authorization")
	endpoint := r.URL.Path
	go func() {
		defer finished()
		defer func() {
			req, _ := http.NewRequest("DELETE", loc.String(), nil)
			if z, err := local.Do(req); err == nil {
				z.Body.Close()
			}
		}()
		if e := g.encode(ctx, name, endpoint, auth, p.media); e != nil && ctx.Err() == nil {
			log.Printf("RK publish %s: %v", name, e)
		}
	}()
	w.Header().Set("Content-Type", "application/sdp")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(answer)
}

// Wait for this publication's browser ICE connection before attaching the Rockchip reader.
func inputReady(ctx context.Context, name string) bool {
	req, _ := http.NewRequestWithContext(ctx, "GET", "http://127.0.0.1:19997/v3/paths/get/"+name, nil)
	res, e := local.Do(req)
	if e != nil {
		return false
	}
	defer res.Body.Close()
	var v struct{ Ready bool }
	return res.StatusCode == 200 && json.NewDecoder(io.LimitReader(res.Body, 16384)).Decode(&v) == nil && v.Ready
}
func (g *gateway) encode(parent context.Context, name, endpoint, auth string, v video) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	deadline := time.NewTimer(30 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(180 * time.Millisecond)
	defer tick.Stop()
	for !inputReady(ctx, name) {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return fmt.Errorf("camera did not connect")
		case <-tick.C:
		}
	}
	// The native publisher accepts a local WHIP URL. Only this loopback listener may spend the
	// current user's authorization on the publication previously issued by the cloud.
	listener, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		return e
	}
	secret := "/" + nonce()
	sig := &http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != secret || r.Method != "POST" {
			http.NotFound(w, r)
			return
		}
		b, e := limited(r.Body, limit)
		if e != nil {
			http.Error(w, "bad offer", 400)
			return
		}
		z, e := g.upstream(r.Context(), "POST", endpoint, auth, "application/sdp", b)
		if e != nil {
			http.Error(w, "upstream unavailable", 502)
			return
		}
		defer z.Body.Close()
		out, e := limited(z.Body, limit)
		if e != nil || z.StatusCode/100 != 2 || !bytes.Contains(out, []byte("m=video ")) {
			http.Error(w, "upstream refused video", 502)
			return
		}
		w.Header().Set("Content-Type", "application/sdp")
		w.WriteHeader(201)
		w.Write(out)
	})}
	go sig.Serve(listener)
	defer sig.Close()
	width := strconv.Itoa(bounded(v.Width, 1280, 16, 4096))
	height := strconv.Itoa(bounded(v.Height, 720, 16, 4096))
	fps := bounded(v.Fps, 25, 1, 60)
	bps := bounded(v.TargetBitrateKbps, 500, 20, 6000) * 1000
	bin := filepath.Join(g.cfg.Binaries, "h264_whip_publisher")
	reader := exec.CommandContext(ctx, bin, "-whep-capture", g.cfg.Media+"/"+name+"/whep", "-zha-output", "-", "-capture-width", width, "-capture-height", height, "-capture-fps", strconv.Itoa(fps))
	encoder := exec.CommandContext(ctx, filepath.Join(g.cfg.Binaries, "mpp_dec_roi_bench"), "-i", "/dev/stdin", "-o", "/dev/stdout", "--dec", "h264", "--enc", "h264", "-w", width, "-h", height, "-n", "0", "--fps", strconv.Itoa(fps), "--bps", fmt.Sprintf("%d:%d:%d", bps, bps/2, bps*5/4), "--rc-mode", "1", "--gop", strconv.Itoa(2*fps))
	encoder.Env = append(os.Environ(), "MPP_DEC_ROI_INPUT_AU_FRAMING=1", "MPP_DEC_ROI_OUTPUT_AU_FRAMING=1", "MPP_DEC_ROI_ASYNC_DECODE=1", "MPP_DEC_ROI_PARSER_SPLIT=0", "mpp_output_unbuffered=1", "roi_enable=1", "auto_roi_enable=1", "auto_roi_source=diff")
	// Each camera has its own recovery marker. A viewer joining an already
	// running intra-refresh stream needs a fresh IDR from this encoder.
	feedback, err := os.MkdirTemp("", "weitong-camera-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(feedback)
	requestIDR := filepath.Join(feedback, "request-idr")
	encoder.Env = append(encoder.Env, "MPP_DEC_ROI_FORCE_IDR_REQUEST_PATH="+requestIDR)
	senderBin := g.cfg.Uplink
	if senderBin == "" {
		senderBin = bin
	}
	args := []string{"-input", "/dev/stdin", "-whip-url", "http://" + listener.Addr().String() + secret, "-keyframe-request-path", requestIDR}
	if g.cfg.Uplink != "" {
		out, err := uplinkInterface(ctx, g.target.Hostname())
		if err != nil {
			return err
		}
		args = append(args, "-uplink-interface", out)
	}
	sender := exec.CommandContext(ctx, senderBin, args...)
	firstR, firstW, e := os.Pipe()
	if e != nil {
		return e
	}
	secondR, secondW, e := os.Pipe()
	if e != nil {
		firstR.Close()
		firstW.Close()
		return e
	}
	reader.Stdout = firstW
	encoder.Stdin = firstR
	encoder.Stdout = secondW
	sender.Stdin = secondR
	// None of the command lines or diagnostics contains the user's Bearer.
	cmds := []*exec.Cmd{sender, encoder, reader}
	done := make(chan error, len(cmds))
	started := 0
	for i, c := range cmds {
		diag, err := c.StderrPipe()
		if err != nil {
			e = err
			break
		}
		go mediaLog(diag, []string{"uplink", "mpp", "camera"}[i])
		if e = c.Start(); e != nil {
			break
		}
		started++
		go func(c *exec.Cmd) { done <- c.Wait() }(c)
	}
	for _, f := range []*os.File{firstR, firstW, secondR, secondW} {
		f.Close()
	}
	if e == nil {
		log.Printf("RK encoder started publication=%s target_kbps=%d", name, bps/1000)
		watch := time.NewTicker(3 * time.Second)
		defer watch.Stop()
		misses := 0
	loop:
		for {
			select {
			case e = <-done:
				started--
				break loop
			case <-ctx.Done():
				e = ctx.Err()
				break loop
			case <-watch.C:
				if inputReady(ctx, name) {
					misses = 0
				} else {
					misses++
				}
				if misses >= 2 {
					break loop
				}
			}
		}
	}
	cancel()
	for ; started > 0; started-- {
		<-done
	}
	return e
}

var mediaAddress = regexp.MustCompile(`(?:https?|rtsp)://[^ ]+|/[a-f0-9]{24,}`)

func mediaLog(input io.Reader, stage string) {
	scanner := bufio.NewScanner(input)
	var last time.Time
	lines := 0
	for scanner.Scan() {
		s := scanner.Text()
		lines++
		if lines > 10 && time.Since(last) < 5*time.Second && !strings.Contains(strings.ToLower(s), "error") {
			continue
		}
		if len(s) > 240 {
			s = s[:240]
		}
		log.Printf("RK %s %s", stage, mediaAddress.ReplaceAllString(s, "[media]"))
		last = time.Now()
	}
}

// Dialing UDP selects the kernel route; no meeting data is sent by this socket.
func uplinkInterface(ctx context.Context, host string) (string, error) {
	var d net.Dialer
	c, err := d.DialContext(ctx, "udp4", net.JoinHostPort(host, "443"))
	if err != nil {
		return "", err
	}
	defer c.Close()
	ip := c.LocalAddr().(*net.UDPAddr).IP
	links, err := net.Interfaces()
	if err != nil {
		return "", err
	}
	for _, link := range links {
		addrs, err := link.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			if n, ok := addr.(*net.IPNet); ok && n.IP.Equal(ip) {
				return link.Name, nil
			}
		}
	}
	return "", fmt.Errorf("未找到前往云端的媒体网卡")
}
