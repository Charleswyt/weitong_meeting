package observability

import (
	"sync"
	"testing"
	"time"
)

func TestNormalizePath(t *testing.T) {
	cases := map[string]string{
		"/api/v1/meetings/12345/state":                         "/api/v1/meetings/:id/state",
		"/api/v1/meetings/99/publications/pub_1234567890abcdef/whip": "/api/v1/meetings/:id/publications/:id/whip",
		"/api/v1/auth/login":                                   "/api/v1/auth/login",
		"":                                                     "/",
	}
	for in, want := range cases {
		if got := normalizePath(in); got != want {
			t.Errorf("normalizePath(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCollectorConcurrentRecord(t *testing.T) {
	c := &Collector{
		startedAt: time.Now(),
		routes:    make(map[string]*routeMetric),
	}
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				status := 200
				if j%10 == 0 {
					status = 500
				}
				c.RecordHTTP("GET", "/api/v1/meetings/100/state", status, 12*time.Millisecond)
			}
		}(i)
	}
	wg.Wait()

	if got := c.totalReq.Load(); got != 800 {
		t.Fatalf("totalReq = %d, want 800", got)
	}
	if got := c.totalErr.Load(); got != 80 {
		t.Fatalf("totalErr = %d, want 80", got)
	}
}
