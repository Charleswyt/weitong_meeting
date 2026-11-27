package main

// Ocean's WebCodecs reader expects a parameter-set record before the first AVC
// picture and after SPS changes. WebRTC may send these NALs before or in the IDR.
type browserAVCConfig struct {
	sps []byte
	pps []byte
}

func (c *browserAVCConfig) keyframeConfig(nalus [][]byte) []byte {
	keyframe := false
	for _, nal := range nalus {
		if len(nal) == 0 {
			continue
		}
		switch nal[0] & 0x1f {
		case 7:
			c.sps = append(c.sps[:0], nal...)
		case 8:
			c.pps = append(c.pps[:0], nal...)
		case 5:
			keyframe = true
		}
	}
	if !keyframe || len(c.sps) == 0 || len(c.pps) == 0 {
		return nil
	}
	result := make([]byte, 0, 8+len(c.sps)+len(c.pps))
	for _, nal := range [][]byte{c.sps, c.pps} {
		result = append(result, 0, 0, 0, 1)
		result = append(result, nal...)
	}
	return result
}
