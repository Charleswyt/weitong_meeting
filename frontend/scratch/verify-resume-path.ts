// 「续看上次那条录制」地址的回归用例（纯逻辑，node 直跑：`node scratch/verify-resume-path.ts`）。
//
// 钉的是 2026-09-30 现场那个 bug：只记 meetingId、菜单再拼回 `/recordings/play/${id}`，
// 本机录制的 `?local=<清单 id>` 就丢了 → 点「录制会议」变成查会议 `local` 的云端归档
// → 后端回「没有找到这场会议的录制归档」。第 1 条用例就是它。
import { playbackResumePath, rememberPlaybackPath, forgetPlaybackPath, isPlaybackPath, type PlaybackPathStore } from '../src/utils/playbackResume.ts'

let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`)
}

function fakeStore(seed: Record<string, string> = {}): PlaybackPathStore & { dump: () => Record<string, string> } {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v) },
    removeItem: (k) => { map.delete(k) },
    dump: () => Object.fromEntries(map),
  }
}

// 1) 本机录制：查询串必须原样留住（旧写法在这里丢的就是它）
{
  const s = fakeStore()
  rememberPlaybackPath('/recordings/play/local?local=disk-1790765452547', s)
  const got = playbackResumePath(s)
  check(
    '本机录制：续看地址带着 ?local= 一起存回',
    got === '/recordings/play/local?local=disk-1790765452547',
    got || '(空)',
  )
}

// 2) 云端：带 ?rec= 的多路回放同样原样留住
{
  const s = fakeStore()
  rememberPlaybackPath('/recordings/play/meeting_123?rec=rec_9', s)
  check('云端：?rec= 一起留住', playbackResumePath(s) === '/recordings/play/meeting_123?rec=rec_9', playbackResumePath(s))
}

// 3) 旧版本留下的脏值（只有 id、甚至只有 'local'）一律当没有 → 菜单落回列表页
{
  const s = fakeStore({ recordingPlaybackPath: 'local' })
  check('脏值：不当作回放地址（宁可少一个续看入口，也不要一个必然报错的入口）', playbackResumePath(s) === '', playbackResumePath(s))
  const s2 = fakeStore({ recordingPlaybackPath: '/recordings/play/local?local=x' })
  check('对照：正常的回放地址能读出来', playbackResumePath(s2) === '/recordings/play/local?local=x', playbackResumePath(s2))
}

// 4) 非回放地址不覆盖已有值（只有回放页会调 remember，这里防的是调用方写错）
{
  const s = fakeStore()
  rememberPlaybackPath('/recordings/play/local?local=keep', s)
  rememberPlaybackPath('/recordings', s)
  check('非回放地址不写进去', playbackResumePath(s) === '/recordings/play/local?local=keep', playbackResumePath(s))
}

// 5) 忘记（点返回 / 进列表页）：读回空串
{
  const s = fakeStore()
  rememberPlaybackPath('/recordings/play/local?local=x', s)
  forgetPlaybackPath(s)
  check('忘记之后读回空串', playbackResumePath(s) === '' && !('recordingPlaybackPath' in s.dump()), JSON.stringify(s.dump()))
}

// 6) 判据本身：前缀匹配、空值与非字符串都不算
{
  check(
    'isPlaybackPath 判据',
    isPlaybackPath('/recordings/play/x') &&
      !isPlaybackPath('/recordings') &&
      !isPlaybackPath('') &&
      !isPlaybackPath(undefined as unknown as string),
    '',
  )
}

console.log(`\n断言结果：${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
