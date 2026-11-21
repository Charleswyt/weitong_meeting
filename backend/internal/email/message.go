package email

import (
	"encoding/base64"
	"fmt"
	"html"
	"strings"
)

const otpTTLMinutes = 5

func purposeTitle(purpose string) string {
	if purpose == "reset" {
		return "找回密码"
	}
	return "登录"
}

func purposeSubject(cfgSubject, purpose string) string {
	if purpose == "reset" {
		return "卫通会议找回密码验证码"
	}
	if cfgSubject != "" {
		return cfgSubject
	}
	return "卫通会议登录验证码"
}

// encodeSubject RFC 2047，避免中文主题在部分客户端乱码。
func encodeSubject(s string) string {
	return "=?UTF-8?B?" + base64.StdEncoding.EncodeToString([]byte(s)) + "?="
}

func plainBody(code, purpose string) string {
	title := purposeTitle(purpose)
	return strings.Join([]string{
		"卫通会议 · " + title + "验证码",
		"",
		"您的验证码是：",
		"",
		"    " + code,
		"",
		fmt.Sprintf("有效期 %d 分钟。请勿将验证码告知他人。", otpTTLMinutes),
		"如非本人操作，请忽略本邮件。",
		"",
		"—— 卫通会议",
	}, "\r\n")
}

func htmlBody(code, purpose string) string {
	title := purposeTitle(purpose)
	safeCode := html.EscapeString(code)
	safeTitle := html.EscapeString(title)
	// 邮件客户端兼容：表格布局 + 内联样式；验证码用大号等宽字，单独色块突出。
	return fmt.Sprintf(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>卫通会议验证码</title>
</head>
<body style="margin:0;padding:0;background:#0B1220;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">
  <table role="presentation" width="100%%" cellspacing="0" cellpadding="0" border="0" style="background:#0B1220;padding:32px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%%" cellspacing="0" cellpadding="0" border="0" style="max-width:480px;background:#111A2E;border-radius:16px;overflow:hidden;border:1px solid rgba(120,180,255,0.18);">
          <tr>
            <td style="padding:28px 28px 12px;background:linear-gradient(135deg,#0C1C38 0%%,#165DFF 120%%);">
              <div style="font-size:13px;letter-spacing:0.08em;color:rgba(255,255,255,0.72);text-transform:uppercase;">WEITONG MEETING</div>
              <div style="margin-top:8px;font-size:22px;font-weight:700;color:#FFFFFF;line-height:1.3;">卫通会议</div>
              <div style="margin-top:6px;font-size:14px;color:rgba(255,255,255,0.78);">%s验证码</div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 28px 8px;">
              <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#D6DEEE;">
                请使用下方验证码完成%s。验证码<strong style="color:#FFFFFF;">必须完整输入</strong>，请勿转发本邮件。
              </p>
              <table role="presentation" width="100%%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="center" style="padding:18px 12px;background:#0A1424;border-radius:12px;border:1px solid rgba(22,93,255,0.45);">
                    <div style="font-size:12px;color:#8FA3C4;letter-spacing:0.12em;margin-bottom:10px;">验证码</div>
                    <div style="font-size:36px;line-height:1.2;font-weight:700;letter-spacing:0.28em;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#5B9DFF;">%s</div>
                  </td>
                </tr>
              </table>
              <p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:#8FA3C4;">
                有效期 <span style="color:#FFFFFF;font-weight:600;">%d 分钟</span>。超时请重新获取。
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 28px 28px;">
              <p style="margin:0;font-size:12px;line-height:1.6;color:#6B7C99;">
                如非本人操作，请忽略本邮件。卫通会议不会索要您的验证码。
              </p>
            </td>
          </tr>
        </table>
        <p style="margin:16px 0 0;font-size:11px;color:#4A5870;">本邮件由系统自动发送，请勿直接回复。</p>
      </td>
    </tr>
  </table>
</body>
</html>`, safeTitle, safeTitle, safeCode, otpTTLMinutes)
}

// buildCodeMessage 组装 multipart/alternative：纯文本兜底 + HTML 版面，验证码两边都醒目。
func buildCodeMessage(from, to, subject, code, purpose string) string {
	boundary := "weitong_otp_" + strings.ReplaceAll(code, " ", "")
	plain := plainBody(code, purpose)
	htmlPart := htmlBody(code, purpose)
	return strings.Join([]string{
		"From: " + from,
		"To: " + to,
		"Subject: " + encodeSubject(subject),
		"MIME-Version: 1.0",
		"Content-Type: multipart/alternative; boundary=\"" + boundary + "\"",
		"",
		"--" + boundary,
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: 8bit",
		"",
		plain,
		"",
		"--" + boundary,
		"Content-Type: text/html; charset=UTF-8",
		"Content-Transfer-Encoding: 8bit",
		"",
		htmlPart,
		"",
		"--" + boundary + "--",
		"",
	}, "\r\n")
}
