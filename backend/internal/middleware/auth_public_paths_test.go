package middleware

import (
	"reflect"
	"testing"

	v1 "cloud-conference-backend/api/v1"
)

// 公开白名单必须与路由声明**逐字符一致**：路由是 `/api/v1` 组前缀 + api/v1 结构体 g.Meta 里那条
// path 拼出来的，两处任一改动而另一处没跟上，免登录探测就会被自己那一层的鉴权踢成 401 ——
// 而前端把 401 当"登录态失效"，后果是页面直接回到登录页，看着像功能坏了。
func TestPublicAuthPathsMatchRouteDeclaration(t *testing.T) {
	field, ok := reflect.TypeOf(v1.AutoLoginReq{}).FieldByName("Meta")
	if !ok {
		t.Fatal("v1.AutoLoginReq 上没有 g.Meta 字段，路由前缀对账这条测试失去意义")
	}
	declared := "/api/v1" + field.Tag.Get("path")

	if _, ok := publicAuthPaths[declared]; !ok {
		t.Fatalf("路由声明是 %s，但公开白名单里没有这一条（少一个字符都不会放行）", declared)
	}

	// 白名单只该有登录相关公开入口。多出来的每一条都是"不需要凭据就能碰"的入口，加它必须是有意的。
	want := map[string]bool{
		"/api/v1/auth/login":              true,
		"/api/v1/auth/sm2-public-key":     true,
		"/api/v1/auth/sms/send":           true,
		"/api/v1/auth/sms/login":          true,
		"/api/v1/auth/sms/reset-password": true,
		"/api/v1/auth/email/send":         true,
		"/api/v1/auth/email/login":        true,
		declared:                          true,
	}
	for path := range publicAuthPaths {
		if !want[path] {
			t.Errorf("公开白名单里多了一条 %s，确认它「不需要凭据也能打」才补进 want", path)
		}
	}
	for path := range want {
		if _, ok := publicAuthPaths[path]; !ok {
			t.Errorf("公开白名单少了 %s", path)
		}
	}
}
