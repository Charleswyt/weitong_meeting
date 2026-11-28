package email

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/smtp"
	"time"
)

// SMTP 经标准 SMTP（默认 SSL 465）发验证码，适配 126/163 等国内邮箱。
type SMTP struct {
	cfg Config
}

func NewSMTP(cfg Config) *SMTP {
	if cfg.SMTPPort == 0 {
		cfg.SMTPPort = 465
	}
	if cfg.SMTPHost == "" {
		cfg.SMTPHost = "smtp.126.com"
	}
	if cfg.Subject == "" {
		cfg.Subject = "卫通会议登录验证码"
	}
	if cfg.SMTPUser == "" {
		cfg.SMTPUser = cfg.From
	}
	return &SMTP{cfg: cfg}
}

func (s *SMTP) Name() string { return "smtp" }

func (s *SMTP) configured() error {
	if s.cfg.From == "" || s.cfg.SMTPPassword == "" || s.cfg.SMTPPassword == "__REPLACE_ME__" {
		return fmt.Errorf("邮件 SMTP 未配置：请在 config.yaml 的 auth.email 填 from 与 smtp.password（126 授权码）")
	}
	return nil
}

func (s *SMTP) SendCode(ctx context.Context, toEmail, code, purpose string) error {
	if err := s.configured(); err != nil {
		return err
	}
	subj := purposeSubject(s.cfg.Subject, purpose)
	return s.send(ctx, toEmail, buildCodeMessage(s.cfg.From, toEmail, subj, code, purpose))
}

func (s *SMTP) SendMeetingInvite(ctx context.Context, toEmail string, inv MeetingInvite) error {
	if err := s.configured(); err != nil {
		return err
	}
	return s.send(ctx, toEmail, buildInviteMessage(s.cfg.From, toEmail, inv))
}

func (s *SMTP) send(ctx context.Context, toEmail, msg string) error {
	addr := fmt.Sprintf("%s:%d", s.cfg.SMTPHost, s.cfg.SMTPPort)
	auth := smtp.PlainAuth("", s.cfg.SMTPUser, s.cfg.SMTPPassword, s.cfg.SMTPHost)

	dialer := &net.Dialer{Timeout: 15 * time.Second}
	raw, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return fmt.Errorf("连接 SMTP %s: %w", addr, err)
	}
	tlsConn := tls.Client(raw, &tls.Config{ServerName: s.cfg.SMTPHost, MinVersion: tls.VersionTLS12})
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		_ = raw.Close()
		return fmt.Errorf("SMTP TLS: %w", err)
	}
	client, err := smtp.NewClient(tlsConn, s.cfg.SMTPHost)
	if err != nil {
		_ = tlsConn.Close()
		return fmt.Errorf("SMTP 客户端: %w", err)
	}
	defer client.Close()

	if err := client.Auth(auth); err != nil {
		return fmt.Errorf("SMTP 认证失败（检查授权码）: %w", err)
	}
	if err := client.Mail(s.cfg.From); err != nil {
		return err
	}
	if err := client.Rcpt(toEmail); err != nil {
		return err
	}
	w, err := client.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write([]byte(msg)); err != nil {
		_ = w.Close()
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return client.Quit()
}
