// 读合成产物的 EBML 头，量出**文件自己的**时长与画面尺寸 —— 第 16 项"拼成完整的一个文件"要有实测数，
// 不看界面写了什么。只读字节，不猜。
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const buf = readFileSync(file)

// EBML 变长整数：前导零个数决定长度
function readVint(at) {
  const first = buf[at]
  const len = 8 - Math.clz32(first & 0xff) + (first & 0x80 ? 0 : 0)
  let marker = 0x80
  let n = 1
  while (marker && !(first & marker)) {
    marker >>= 1
    n++
  }
  let value = first & (0xff >> n)
  for (let i = 1; i < n; i++) value = value * 256 + buf[at + i]
  return { size: value, bytes: n }
}

function findElement(idBytes) {
  const id = Buffer.from(idBytes).toString('hex')
  for (let at = 0; at < buf.length - idBytes.length; at++) {
    if (buf.subarray(at, at + idBytes.length).toString('hex') === id) {
      const v = readVint(at + idBytes.length)
      const payload = buf.subarray(at + idBytes.length + v.bytes, at + idBytes.length + v.bytes + v.size)
      return { at, v, payload }
    }
  }
  return null
}
const uint = (b) => b.reduce((acc, x) => acc * 256 + x, 0)
const floatBE = (b) => (b.length === 4 ? b.readFloatBE(0) : b.readDoubleBE(0))

const duration = findElement([0x44, 0x89])
const timecodeScale = findElement([0x2e, 0xd7, 0xb1])

// 只报 Duration：TrackWidth/Height 要用完整的 EBML 树遍历才可靠，
// 这里这种"扫字节"的读法会撞到 payload 里的同名字节串，量出来的宽高不可信，就不写了。
console.log('文件           ', file)
console.log('字节数         ', buf.length)
console.log('TimecodeScale  ', timecodeScale ? uint(timecodeScale.payload) : '未扫到')
console.log('Duration 元素  ', duration ? `${floatBE(duration.payload)} ms (payload ${duration.payload.length} 字节)` : '缺')
