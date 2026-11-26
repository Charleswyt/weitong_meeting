package meeting

import (
	"testing"

	"cloud-conference-backend/internal/service/thirdparty"
)

func TestExternalRoomControlsRequireConfirmedHost(t *testing.T) {
	state := &thirdparty.MeetingResponse{
		Meeting: thirdparty.MeetingInfo{HostParticipantId: "host"},
		Participants: []thirdparty.ParticipantState{
			{ParticipantId: "host", IsHost: true},
			{ParticipantId: "guest"},
		},
	}
	for _, hostFromRoster := range []bool{false, true} {
		if hostFromRoster {
			state.Meeting.HostParticipantId = ""
		}
		if !canControlExternalRoom(state, "host") || canControlExternalRoom(state, "guest") ||
			canControlExternalRoom(state, "") || canControlExternalRoom(nil, "host") {
			t.Fatalf("unexpected control privileges, host from roster %v", hostFromRoster)
		}
	}
}
