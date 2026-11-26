package service

import (
	"testing"

	"github.com/gogf/gf/v2/os/gtime"

	"cloud-conference-backend/internal/consts"
	"cloud-conference-backend/internal/model/entity"
	"cloud-conference-backend/internal/service/thirdparty"
)

func TestScheduleItemPrefersLocalStartTimeAndScheduledStatus(t *testing.T) {
	booked := gtime.NewFromStr("2026-11-27 10:00:00")
	createdNow := gtime.NewFromStr("2026-11-26 20:00:00").Timestamp()

	item := ScheduleItem{
		Local: &entity.MeetingAppointment{
			Id:         1,
			Title:      "明日评审会",
			StartTime:  booked,
			Status:     consts.MeetingStatusScheduled,
			LaunchKind: "scheduled",
		},
		Upstream: thirdparty.ThirdMeeting{
			MeetingId:              "room-1",
			MeetingNumber:          "12345678",
			Status:                 "running",
			StartAt:                createdNow,
			ActiveParticipantCount: 0,
			ParticipantCount:       0,
		},
	}

	if got := item.StartAt(); got != booked.Timestamp() {
		t.Fatalf("StartAt() = %d, want booked %d (must not be overwritten by upstream room createdAt)", got, booked.Timestamp())
	}
	if got := item.Status(); got != consts.MeetingStatusScheduled {
		t.Fatalf("Status() = %q, want %q when scheduled meeting has 0 participants", got, consts.MeetingStatusScheduled)
	}

	// 一旦有人真正入会，状态应切为 running
	item.Upstream.ActiveParticipantCount = 1
	if got := item.Status(); got != consts.MeetingStatusRunning {
		t.Fatalf("Status() = %q, want %q when active participant joined", got, consts.MeetingStatusRunning)
	}
}
