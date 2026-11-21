// 发布来源申报（三方 publication.sourceType）的判据。
//
// 三方按"这条视频是不是船端浏览器发的"分档：船端摄像头/屏幕 → rk_browser_roi（要过船内 RK 接收槽），
// 其余一律 browser_whip。**船端音频仍是 browser_whip** —— 这一条最容易在"统一一下来源"时被一起改掉，
// 改掉之后音频也会走 RK 路径，而现场只会表现为"船端听不到声音"，看不出是这行改的。
package meeting

import (
	"testing"

	"cloud-conference-backend/internal/consts"
)

func TestPublicationSourceType(t *testing.T) {
	for name, tc := range map[string]struct {
		mediaKind, endpointType, deviceID string
		wantType, wantDevice              string
	}{
		"船端摄像头":         {"camera", "ship", "RK3588-BJ4", consts.SourceTypeRkBrowserRoi, "RK3588-BJ4"},
		"船端屏幕共享":        {"screen", "ship", "RK3588-BJ4", consts.SourceTypeRkBrowserRoi, "RK3588-BJ4"},
		"船端音频仍是浏览器直发":   {"audio", "ship", "RK3588-BJ4", consts.SourceTypeBrowserWhip, ""},
		"岸端摄像头":         {"camera", "shore", "", consts.SourceTypeBrowserWhip, ""},
		"岸端即使有设备号也不改来源": {"camera", "shore", "RK3588-BJ4", consts.SourceTypeBrowserWhip, ""},
		"船端缺设备号回落浏览器直发": {"camera", "ship", "", consts.SourceTypeBrowserWhip, ""},
	} {
		t.Run(name, func(t *testing.T) {
			gotType, gotDevice := publicationSourceType(tc.mediaKind, tc.endpointType, tc.deviceID)
			if gotType != tc.wantType || gotDevice != tc.wantDevice {
				t.Fatalf("publicationSourceType(%q,%q,%q) = (%q,%q)，期望 (%q,%q)",
					tc.mediaKind, tc.endpointType, tc.deviceID, gotType, gotDevice, tc.wantType, tc.wantDevice)
			}
		})
	}
}
