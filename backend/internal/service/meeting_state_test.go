package service

import "testing"

// 端类型映射：三方是取值真源（实测 ship=船端、shore=岸端），
// 空值才轮到兜底，兜底按本实例部署侧，而部署侧默认 edge。
func TestNodeTypeOf(t *testing.T) {
	cases := []struct {
		name     string
		endpoint string
		side     string
		want     string
	}{
		{"船端是边端", "ship", "cloud", "edge"},
		{"岸端是云端", "shore", "edge", "cloud"},
		{"大写取值", "SHIP", "cloud", "edge"},
		{"带空格的取值", " shore ", "cloud", "cloud"},
		{"边端直接报值", "edge", "cloud", "edge"},
		{"云端直接报值", "cloud", "edge", "cloud"},
		{"板卡算边端", "board", "cloud", "edge"},
		{"未获取到_默认边端", "", "edge", "edge"},
		{"未获取到_本端是云端", "", "cloud", "cloud"},
		{"未知取值不假装认识_默认边端", "submarine", "edge", "edge"},
		{"未知取值_本端是云端", "submarine", "cloud", "cloud"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			old := DeploymentSide
			DeploymentSide = c.side
			defer func() { DeploymentSide = old }()
			if got := NodeTypeOf(c.endpoint); got != c.want {
				t.Fatalf("NodeTypeOf(%q) 部署侧=%q 得 %q，期望 %q", c.endpoint, c.side, got, c.want)
			}
		})
	}
}

// 兜底落在边端：配置缺 deployment.side 这个键时也必须显示 edge（2026-09-29 口径）。
func TestDeploymentSideDefaultsToEdge(t *testing.T) {
	if DeploymentSide != "edge" {
		t.Fatalf("DeploymentSide 包级默认值是 %q，期望 \"edge\"", DeploymentSide)
	}
}

// 未知取值只告警一次：这条不在请求路径上刷屏，但仍要能被发现。
func TestWarnUnknownNodeTypeOnlyOnce(t *testing.T) {
	warnUnknownNodeType("submarine")
	warnUnknownNodeType("submarine")
	if !nodeTypeWarned["submarine"] {
		t.Fatal("未知端类型没有被登记为已告警")
	}
}
