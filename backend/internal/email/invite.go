package email

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"html"
	"strings"
)

func inviteSubject(inv MeetingInvite) string {
	inviter := inv.InviterName
	if inviter == "" {
		inviter = "卫通会议用户"
	}
	return fmt.Sprintf("%s 邀请您参加会议：%s", inviter, inv.Title)
}

func inviteLines(inv MeetingInvite) [][2]string {
	rows := [][2]string{{"会议主题", inv.Title}, {"会议号", inv.MeetingNo}}
	if inv.StartTime != "" {
		rows = append(rows, [2]string{"开始时间", inv.StartTime})
	}
	if inv.DurationMinutes > 0 {
		rows = append(rows, [2]string{"会议时长", fmt.Sprintf("%d 分钟", inv.DurationMinutes)})
	}
	if inv.InviterName != "" {
		rows = append(rows, [2]string{"邀请人", inv.InviterName})
	}
	if inv.HasPassword {
		rows = append(rows, [2]string{"入会密码", "本会议设有入会密码，请向邀请人获取"})
	}
	return rows
}

func invitePlainBody(inv MeetingInvite) string {
	greet := "您好："
	if inv.InviteeName != "" {
		greet = inv.InviteeName + "，您好："
	}
	lines := []string{greet, "", "您收到一场卫通会议的邀请。", ""}
	for _, r := range inviteLines(inv) {
		lines = append(lines, r[0]+"："+r[1])
	}
	if inv.JoinUrl != "" {
		lines = append(lines, "", "入会链接：", inv.JoinUrl)
	}
	lines = append(lines, "", "也可以在卫通会议中输入会议号入会。", "", "—— 卫通会议")
	return strings.Join(lines, "\r\n")
}

func inviteHtmlBody(inv MeetingInvite) string {
	greet := "您好："
	if inv.InviteeName != "" {
		greet = html.EscapeString(inv.InviteeName) + "，您好："
	}
	var rows strings.Builder
	for _, r := range inviteLines(inv) {
		fmt.Fprintf(&rows,
			`<tr><td style="padding:6px 0;width:84px;font-size:13px;color:#8FA3C4;vertical-align:top;">%s</td><td style="padding:6px 0;font-size:14px;color:#FFFFFF;">%s</td></tr>`,
			html.EscapeString(r[0]), html.EscapeString(r[1]))
	}
	button := ""
	if inv.JoinUrl != "" {
		u := html.EscapeString(inv.JoinUrl)
		button = fmt.Sprintf(`<tr><td style="padding:8px 28px 4px;">
  <a href="%s" style="display:inline-block;padding:12px 28px;background:#165DFF;color:#FFFFFF;text-decoration:none;border-radius:10px;font-size:15px;font-weight:600;">加入会议</a>
  <p style="margin:12px 0 0;font-size:12px;line-height:1.6;color:#6B7C99;word-break:break-all;">按钮无法点击时，复制此链接到浏览器打开：<br/>%s</p>
</td></tr>`, u, u)
	}
	return fmt.Sprintf(`<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>卫通会议邀请</title></head>
<body style="margin:0;padding:0;background:#0B1220;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">
  <table role="presentation" width="100%%" cellspacing="0" cellpadding="0" border="0" style="background:#0B1220;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%%" cellspacing="0" cellpadding="0" border="0" style="max-width:520px;background:#111A2E;border-radius:16px;overflow:hidden;border:1px solid rgba(120,180,255,0.18);">
        <tr><td style="padding:28px 28px 14px;background:linear-gradient(135deg,#0C1C38 0%%,#165DFF 120%%);">
          <div style="font-size:13px;letter-spacing:0.08em;color:rgba(255,255,255,0.72);">WEITONG MEETING</div>
          <div style="margin-top:8px;font-size:22px;font-weight:700;color:#FFFFFF;line-height:1.3;">会议邀请</div>
        </td></tr>
        <tr><td style="padding:24px 28px 8px;">
          <p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#D6DEEE;">%s您收到一场卫通会议的邀请。</p>
          <table role="presentation" width="100%%" cellspacing="0" cellpadding="0" border="0">%s</table>
        </td></tr>
        %s
        <tr><td style="padding:14px 28px 28px;">
          <p style="margin:0;font-size:12px;line-height:1.6;color:#6B7C99;">也可以在卫通会议中输入会议号入会。本邮件由系统自动发送，请勿直接回复。</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`, greet, rows.String(), button)
}

func buildInviteMessage(from, to string, inv MeetingInvite) string {
	nonce := make([]byte, 8)
	_, _ = rand.Read(nonce)
	boundary := "weitong_inv_" + hex.EncodeToString(nonce)
	return strings.Join([]string{
		"From: " + from,
		"To: " + to,
		"Subject: " + encodeSubject(inviteSubject(inv)),
		"MIME-Version: 1.0",
		"Content-Type: multipart/alternative; boundary=\"" + boundary + "\"",
		"",
		"--" + boundary,
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: 8bit",
		"",
		invitePlainBody(inv),
		"",
		"--" + boundary,
		"Content-Type: text/html; charset=UTF-8",
		"Content-Transfer-Encoding: 8bit",
		"",
		inviteHtmlBody(inv),
		"",
		"--" + boundary + "--",
		"",
	}, "\r\n")
}
