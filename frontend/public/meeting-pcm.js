class MeetingPcm extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(1600)
    this.offset = 0
  }
  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel) return true
    let from = 0
    while (from < channel.length) {
      const n = Math.min(this.buffer.length - this.offset, channel.length - from)
      this.buffer.set(channel.subarray(from, from + n), this.offset)
      this.offset += n
      from += n
      if (this.offset === this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer])
        this.buffer = new Float32Array(1600)
        this.offset = 0
      }
    }
    return true
  }
}
registerProcessor('meeting-pcm', MeetingPcm)
