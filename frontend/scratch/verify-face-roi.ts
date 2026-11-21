import { normalizeRegions } from '../src/utils/faceRegions.ts'

// 纯函数判据：坐标归一化、越界裁剪、坏值丢弃。
// 跑法：cd frontend && node scratch/verify-face-roi.ts（Node 24 直接执行 TS）

let failed = 0
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g !== w) {
    console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`)
    failed++
  }
}

eq(
  '中心框',
  normalizeRegions([{ originX: 960, originY: 540, width: 192, height: 192, score: 0.9 }], 1920, 1080),
  [{ x: 0.5, y: 0.5, width: 0.1, height: 0.17777777777777778, score: 0.9 }],
)

const neg = normalizeRegions([{ originX: -100, originY: -50, width: 400, height: 300 }], 1000, 1000)
eq('负坐标保留一条', neg.length, 1)
eq('负坐标 x 夹到 0', neg[0]?.x, 0)
eq('负坐标 y 夹到 0', neg[0]?.y, 0)
eq('越界宽度', neg[0]?.width, 0.4)

const right = normalizeRegions([{ originX: 900, originY: 900, width: 400, height: 400 }], 1000, 1000)
// 裁剪会带浮点尾差，按容差比。
if (Math.abs((right[0]?.width ?? 0) - 0.1) > 1e-9) {
  console.error(`FAIL 右边界宽度截断 got ${right[0]?.width}`)
  failed++
}
if (Math.abs((right[0]?.height ?? 0) - 0.1) > 1e-9) {
  console.error(`FAIL 下边界高度截断 got ${right[0]?.height}`)
  failed++
}

eq('零尺寸丢弃', normalizeRegions([{ originX: 10, originY: 10, width: 0, height: 10 }], 100, 100), [])
eq('无源帧', normalizeRegions([{ originX: 1, originY: 1, width: 10, height: 10 }], 0, 0), [])
eq('NaN 归零', normalizeRegions([{ originX: NaN, originY: 0, width: 10, height: 10 }], 100, 100)[0]?.x, 0)

if (failed) process.exit(1)
console.log('face-roi ok')
