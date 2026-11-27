package main

import (
	"bytes"
	"testing"
)

func TestParameterSetsBeforeAndInsideIDR(t *testing.T) {
	var cfg browserAVCConfig
	if out := cfg.keyframeConfig([][]byte{{0x67, 1}, {0x68, 2}, {0x41, 0}}); out != nil {
		t.Fatal("parameter sets must wait for a keyframe")
	}
	first := cfg.keyframeConfig([][]byte{{0x65, 3}})
	second := cfg.keyframeConfig([][]byte{{0x67, 4}, {0x65, 5}})
	want := []byte{0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68, 2}
	if !bytes.Equal(first, want) || len(second) != len(want) || second[5] != 4 {
		t.Fatal("queued keyframes must retain the parameter sets of their own picture")
	}
}
