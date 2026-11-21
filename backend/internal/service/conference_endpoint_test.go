package service

import (
	"context"
	"testing"
)

// 端别词是三方契约的取值域，映射错了整台设备在会里就是另一端 —— 用表钉死。
func TestEndpointTypeForSide(t *testing.T) {
	cases := []struct{ name, side, want string }{
		{"边端默认", "edge", "ship"},
		{"云端", "cloud", "shore"},
		{"空值按边端兜底（DeploymentSide 默认 edge）", "", "ship"},
		{"大小写与空格不敏感", "  ClOuD  ", "shore"},
		{"不认识的值不当云端", "board", "ship"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := EndpointTypeForSide(c.side); got != c.want {
				t.Fatalf("EndpointTypeForSide(%q) = %q，期望 %q", c.side, got, c.want)
			}
		})
	}
}

// 边端配了设备号才发 ship（契约 §8：ship 时 deviceId 必填）；云端一侧永远不发设备号。
func TestJoinEndpoint(t *testing.T) {
	ctx := context.Background()
	oldSide := DeploymentSide
	t.Cleanup(func() { DeploymentSide = oldSide })

	DeploymentSide = "edge"
	t.Setenv("THIRDPARTY_CONFERENCE_DEVICE_ID", "RK3588-BJ4")
	if et, id := JoinEndpoint(ctx); et != "ship" || id != "RK3588-BJ4" {
		t.Fatalf("边端 + 有设备号 = (%q,%q)，期望 (ship,RK3588-BJ4)", et, id)
	}

	DeploymentSide = "cloud"
	t.Setenv("THIRDPARTY_CONFERENCE_DEVICE_ID", "RK3588-BJ4")
	if et, id := JoinEndpoint(ctx); et != "shore" || id != "" {
		t.Fatalf("云端 = (%q,%q)，期望 (shore,空) —— 设备号只在 ship 时才发", et, id)
	}
}

// 判据自证：坏样本必须真的坏 —— 写死 shore 的旧写法会让边端被三方记成岸端。
func TestEndpointTypeSelfProof(t *testing.T) {
	if got := EndpointTypeForSide("edge"); got == "shore" {
		t.Fatal("边端仍映射成 shore（界面会显示「云」）")
	}
}
