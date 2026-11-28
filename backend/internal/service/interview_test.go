package service

import (
	"regexp"
	"testing"
)

func TestInterviewUsernameBase(t *testing.T) {
	cases := map[string]string{
		"张三":      "zhangsan",
		"欧阳娜娜":    "ouyangnana",
		"Li Ming": "liming",
		"王5":      "wang5",
		"·":       "mianshi",
	}
	for in, want := range cases {
		if got := interviewUsernameBase(in); got != want {
			t.Errorf("interviewUsernameBase(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestReadableInterviewPassword(t *testing.T) {
	re := regexp.MustCompile(`^[BCDFGHJKMNPRSTWZ][aeiu]([bcdfghjkmnprstwz][aeiu]){2}[2-9]{4}$`)
	for i := 0; i < 200; i++ {
		if p := readableInterviewPassword(); !re.MatchString(p) {
			t.Fatalf("口令 %q 不符合易读规则", p)
		}
	}
}
