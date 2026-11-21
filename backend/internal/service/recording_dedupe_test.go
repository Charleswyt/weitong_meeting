package service

import (
	"testing"

	"cloud-conference-backend/internal/service/thirdparty"
)

// 判据：上游目录摊平后同一条只许留一行（2026-10-01 "云端录制列表有重复" 的回归）。
//
// 上游按**分组 offset** 翻页，而目录本身在变（归档、删除）——偏移在两次请求之间会滑动，
// 同一个分组可能被取两次；从前摊平后直接进过滤器，于是同一 recordingId 给前端两行。
func TestDedupeRecordingsKeepsFirstOccurrence(t *testing.T) {
	rows := []thirdparty.ThirdRecording{
		{RecordingId: "rec_a", Title: "会 · 甲 · 摄像头 · 设备", FileSizeBytes: 100},
		{RecordingId: "rec_b", Title: "会 · 乙 · 麦克风 · 设备"},
		{RecordingId: "rec_a", Title: "会 · 甲 · 摄像头 · 设备", FileSizeBytes: 100}, // 翻页重复取到的那一条
		{RecordingId: "rec_c"},
		{RecordingId: "rec_b"},
	}
	got := dedupeRecordings(rows)
	if len(got) != 3 {
		t.Fatalf("应剩 3 行（a/b/c 各一），实得 %d：%+v", len(got), got)
	}
	want := []string{"rec_a", "rec_b", "rec_c"}
	for i, id := range want {
		if got[i].RecordingId != id {
			t.Fatalf("第 %d 行应是 %s，实得 %s（保留顺序：首次出现的那条）", i, id, got[i].RecordingId)
		}
	}
	// 保留的是**首次**出现的那条，字段不能被后到的覆盖
	if got[0].Title != "会 · 甲 · 摄像头 · 设备" || got[0].FileSizeBytes != 100 {
		t.Fatalf("首次出现的字段应被保留，实得 %+v", got[0])
	}
}

// 没有 recordingId 的行去不了重，照原样保留 —— 去重不能把无从判断的行吞掉。
func TestDedupeRecordingsKeepsRowsWithoutId(t *testing.T) {
	rows := []thirdparty.ThirdRecording{{RecordingId: ""}, {RecordingId: "rec_a"}, {RecordingId: ""}}
	got := dedupeRecordings(rows)
	if len(got) != 3 {
		t.Fatalf("无 id 的行必须原样保留（3 行），实得 %d", len(got))
	}
}

// 不改动入参（就地写会把调用方还在读的切片覆盖掉）。
func TestDedupeRecordingsDoesNotMutateInput(t *testing.T) {
	rows := []thirdparty.ThirdRecording{{RecordingId: "a"}, {RecordingId: "b"}, {RecordingId: "a"}}
	_ = dedupeRecordings(rows)
	ids := []string{rows[0].RecordingId, rows[1].RecordingId, rows[2].RecordingId}
	if ids[0] != "a" || ids[1] != "b" || ids[2] != "a" {
		t.Fatalf("入参被就地改写了：%v", ids)
	}
}
