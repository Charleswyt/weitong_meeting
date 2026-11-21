// 录制列表"翻页合并去重"的回归用例（纯逻辑，node 直跑：`node scratch/verify-merge-rows.ts`）。
//
// 钉的是 2026-10-01 现场"云端录制列表好像有重复"：上游目录在两次请求之间会变，
// 同一条录制可能既在第 1 页又在第 2 页，前端 append 就成了两行。
import { mergeUniqueRecordings } from '../src/utils/recordingRows.ts'

let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`)
}
const row = (id: string, startedAt = '2026-10-01T10:00:00+08:00') => ({ recordingId: id, startedAt })

// 1) 第 2 页把第 1 页的最后一条又给回来 → 只留一行（本次报错的回归）
{
  const page1 = [row('a'), row('b')]
  const page2 = [row('b'), row('c')] // 上游偏移滑动导致 b 重复
  const merged = mergeUniqueRecordings(page1, page2)
  check(
    '重复页：同一条只留一行',
    merged.map((r) => r.recordingId).join(',') === 'a,b,c',
    merged.map((r) => r.recordingId).join(','),
  )
}

// 2) 同一页自己就有重复（后端没去重时）也要收敛
{
  const merged = mergeUniqueRecordings([], [row('a'), row('a'), row('b')])
  check('同页重复：也只留一行', merged.map((r) => r.recordingId).join(',') === 'a,b', merged.map((r) => r.recordingId).join(','))
}

// 3) 保留的是**先到**的那行（字段以第一次为准，后面的不覆盖）
{
  const p1 = [{ recordingId: 'a', title: '先到' }]
  const p2 = [{ recordingId: 'a', title: '后到' }]
  const merged = mergeUniqueRecordings(p1, p2)
  check('保留先到的那行', merged.length === 1 && merged[0].title === '先到', JSON.stringify(merged))
}

// 4) 不同 id 一条都不许丢（去重不能顺手吞行）
{
  const merged = mergeUniqueRecordings([row('a')], [row('b'), row('c')])
  check('不同 id 全保留', merged.length === 3, String(merged.length))
}

// 5) 没有 id 的行照原样保留（去不了重，但也不能吞）
{
  const merged = mergeUniqueRecordings([], [row(''), row('a')])
  check('无 id 的行不被吞', merged.length === 2, String(merged.length))
}

// 6) 不改动入参
{
  const p1 = [row('a')]
  const p2 = [row('a')]
  mergeUniqueRecordings(p1, p2)
  check('入参不被就地改写', p1.length === 1 && p2.length === 1, `${p1.length}/${p2.length}`)
}

console.log(`\n断言结果：${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
