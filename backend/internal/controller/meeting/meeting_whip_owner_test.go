package meeting

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// 越权下限的**形状**判据。
//
// 为什么需要它：`WhipTarget.UserId` 与 `WhipForUser` 的语义有专门用例钉着
// （`session/whip_owner_test.go`），但"两个入口是不是都走了带归属的读法"、
// "登记发布时到底有没有把归属写进去"这两件事只体现在调用点上 —— 而这两点被合并或漏掉时，
// 编译与单测都不会红，只有现场出现"B 能拆 A 的流"才看得见。
// 手法照 `TestPrepareRoleBoundaryPerSide`：只认真实调用形式，不扫裸名字。
func TestWhipEntriesAreOwnershipScoped(t *testing.T) {
	// 三个入口：转发 offer（推流）、拆流、上报人脸框。各自都必须走带归属的读法 ——
	// 少任一个，就等于留着一条"同场成员可以动别人的流"的路。
	for _, name := range []string{"Whip", "WhipDelete", "RoiHint"} {
		body := controllerFuncBody(t, name)
		if !strings.Contains(body, "room.WhipForUser(req.PubId, userId)") {
			t.Fatalf("%s 不再按归属读发布 —— 只校验成员资格挡不住同场别人", name)
		}
		if strings.Contains(body, "room.WhipFor(") {
			t.Fatalf("%s 里出现无归属读法 —— 那正是「任何同场成员都能往别人流里推、或把它拆掉」的入口", name)
		}
	}

	create := controllerFuncBody(t, "CreatePublication")
	bound := regexp.MustCompile(`room\.BindWhip\(pubId,\s*session\.WhipTarget\{([^}]*)\}\)`).FindStringSubmatch(create)
	if len(bound) != 2 || !regexp.MustCompile(`\bUserId:\s*userId\b`).MatchString(bound[1]) ||
		!regexp.MustCompile(`\bOfferURL:\s*whipURL\b`).MatchString(bound[1]) {
		t.Fatal("创建发布时没写归属 —— 表里全是零值 UserId，带归属的读法会把本人也挡在外面")
	}

	src, err := os.ReadFile("../../session/registry.go")
	if err != nil {
		t.Fatalf("读不到注册表源码，上面那圈判据等于没跑: %v", err)
	}
	if strings.Contains(string(src), "func (room *MeetingRoom) WhipFor(") {
		t.Fatal("注册表里重新出现了无归属的 WhipFor —— 留着它，下一个调用点就会顺手用它")
	}
}
