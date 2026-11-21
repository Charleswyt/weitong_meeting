package response

import "testing"

// 契约 §1 的状态码 → reason 映射表：前端按这些机器值分支，不再比对中文文案。
func TestStreamReason(t *testing.T) {
	cases := []struct {
		status int
		want   string
	}{
		{401, "not_in_meeting"},
		{403, "forbidden"}, {404, "not_found"},
		{410, "gone"},
		{503, "warming"},
		{502, "upstream_unreachable"},
		{501, "no_channel"},
		{400, "bad_request"},
		{500, "system_error"},
		{418, "system_error"},
	}
	for _, c := range cases {
		if got := streamReason(c.status); got != c.want {
			t.Errorf("streamReason(%d) = %q，期望 %q", c.status, got, c.want)
		}
	}
}
