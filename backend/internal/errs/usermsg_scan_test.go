// 用户可见文案的后端侧门禁（第 7/38 项：`msg` 由后端写成用户能行动的话，实现归属词不外溢）。
//
// 为什么放测试而不是靠人扫：这条规则本周已经栽在"手扫给出 0 命中"上两次（前端 ADR-0058、
// 夹具 ADR-0064），而且这一层最容易漏 —— `response.FailSystem(r, op, err)` 的第一个参数
// **只进日志**（它写 `g.Log().Errorf("%s: %v", op, err)`），真正上桌的是 `errs.Bizf` 里那句。
// 所以本测试刻意**只扫会进 `msg` 的那两类出口**，不去管日志串。
//
// 已知边界（别把它当全覆盖）：只认**单行**字面量的 `errs.Bizf("…")` 与 `R{…Msg: "…"}`；
// 跨行拼接或先赋值给变量再传进来的写法扫不到 —— 所以配套有一条"至少要扫到 N 条"的下限断言，
// 扫描器一旦因为写法变化而静默扫不到东西，就让测试红掉，而不是报"0 命中"。
package errs

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var (
	// 会进 msg 的两类出口
	bizfRe = regexp.MustCompile(`errs\.Bizf\(\s*"((?:[^"\\]|\\.)*)"`)
	msgRe  = regexp.MustCompile(`Msg:\s*"((?:[^"\\]|\\.)*)"`)
	// 契约 §1.2 点名的实现归属词 + 一看就是内部机器码的 snake_case
	bannedWords = []string{"三方", "上游", "板卡", "船端", "岸端", "本地网关"}
	tokenRe     = regexp.MustCompile(`[a-z]+_[a-z_]{2,}`)
)

func scanUserMsgs(root string) (checked int, bad []string, err error) {
	err = filepath.Walk(root, func(p string, info os.FileInfo, e error) error {
		if e != nil {
			return e
		}
		if info.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			return nil
		}
		src, e := os.ReadFile(p)
		if e != nil {
			return e
		}
		for _, re := range []*regexp.Regexp{bizfRe, msgRe} {
			for _, m := range re.FindAllStringSubmatch(string(src), -1) {
				checked++
				text := m[1]
				for _, w := range bannedWords {
					if strings.Contains(text, w) {
						bad = append(bad, p+" 里出现实现归属词「"+w+"」: "+text)
					}
				}
				if tokenRe.MatchString(text) {
					bad = append(bad, p+" 里出现内部机器码: "+text)
				}
			}
		}
		return nil
	})
	return
}

func TestUserFacingMsgsCarryNoInternals(t *testing.T) {
	root := filepath.Join("..", "..")
	checked, bad, err := scanUserMsgs(root)
	if err != nil {
		t.Fatalf("扫描源码失败: %v", err)
	}
	// 下限断言：扫不到东西 = 提取器坏了或被测代码换了写法，此时"没问题"是假阴性。
	if checked < 20 {
		t.Fatalf("只扫到 %d 条用户可见文案，判定为提取器失效而非全部合规", checked)
	}
	t.Logf("扫到 %d 条会进 msg 的文案，全部合规（判据自检见 TestScanJudgeActuallyFires）", checked)
	for _, b := range bad {
		t.Error(b)
	}
}

// 自检：判据必须抓得到一条已知坏的，且不误报一条已知好的。
func TestScanJudgeActuallyFires(t *testing.T) {
	dir := t.TempDir()
	writeCase(t, filepath.Join(dir, "a.go"), `package x
import "cloud-conference-backend/internal/errs"
func f() { _ = errs.Bizf("板卡录制被拒：board_recording_requires_local_gateway") }
func g() { _ = errs.Bizf("请先加入会议") }
`)
	checked, bad, err := scanUserMsgs(dir)
	if err != nil {
		t.Fatal(err)
	}
	if checked != 2 {
		t.Fatalf("应扫到 2 条文案，实得 %d", checked)
	}
	if len(bad) != 2 { // 「板卡」命中归属词，board_... 命中机器码，同一条两处
		t.Fatalf("已知坏样本没被抓全，bad=%v", bad)
	}
	for _, b := range bad {
		if strings.Contains(b, "请先加入会议") {
			t.Fatalf("误报了合规文案: %s", b)
		}
	}
}

func writeCase(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}
