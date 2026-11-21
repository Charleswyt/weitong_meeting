// Package errs 区分两类错误：给用户看的业务拒绝，和只能进日志的内部异常。
//
// 弹窗文案的规则（见单元契约 api-contract.md §1）：只有 BizError 的文案允许原样进 `msg`，
// 其余（三方原始错误体、SQL/驱动报错、GoFrame 英文校验）一律由 response.FailSystem 收敛成「系统异常」。
package errs

import (
	"errors"
	"fmt"
)

type BizError struct {
	msg    string
	reason string
}

func (e *BizError) Error() string { return e.msg }

// Bizf 造一条用户可读、且用户改得对的业务拒绝，例如「仅待开始的会议可取消」。
func Bizf(format string, a ...any) error {
	return &BizError{msg: fmt.Sprintf(format, a...)}
}

// BizReason 给一条业务拒绝附机器码，让调用方按码分支而不是比对中文文案。
func BizReason(err error, reason string) error {
	if b, ok := err.(*BizError); ok {
		b.reason = reason
	}
	return err
}

// BizMessage 是内部异常出口用的判定：非业务错误返回空串，调用方据此改回「系统异常」。
func BizMessage(err error) string {
	var b *BizError
	if errors.As(err, &b) {
		return b.msg
	}
	return ""
}

// BizReasonOf 取业务拒绝的机器码；非业务错误或未标码返回空串。
func BizReasonOf(err error) string {
	var b *BizError
	if errors.As(err, &b) {
		return b.reason
	}
	return ""
}
