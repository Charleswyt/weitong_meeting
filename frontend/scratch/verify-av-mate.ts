// 「同一人的纯音频路」查找判据（`utils/avMate.ts`）。纯函数，Node 24 直跑仓内真源。
//
// 这条判据原先写在会中页里，搜的是 `remoteStreams` —— 那份列表的定义是
// `streams.filter(s => s.video && …)`，**只装视频瓦片**。纯音频发布不是瓦片，永远不在里面，
// 于是"播放音画差"那一格恒显示"这一路的画面自带声音，没有独立音频路"。
// 2026-11-05 同会实测：会里确实有 `kind=audio / audio=true / active=true` 的那一路。
//
// 跑法：node scratch/verify-av-mate.ts   （有失败则退出码 1）

import { findAudioMateId } from '../src/utils/avMate.ts'

let fail = 0
const check = (name: string, cond: boolean, extra = '') => {
  if (!cond) { fail++; console.log(`  FAIL ${name}${extra ? ' · ' + extra : ''}`) } else console.log(`  OK   ${name}`)
}

type S = { id: string; ownerId: string; kind: string; video: boolean; audio: boolean; active: boolean }
const s = (id: string, ownerId: string, kind: string, video: boolean, audio: boolean, active = true): S =>
  ({ id, ownerId, kind, video, audio, active })

// 会里的真实形态：一个人一条 camera + 一条纯 audio
const all = [
  s('cam-a', 'p1', 'camera', true, false),
  s('aud-a', 'p1', 'audio', false, true),
  s('cam-b', 'p2', 'camera', true, false),
  s('aud-b', 'p2', 'audio', false, true),
]

check('在全部流里能找到同一人的纯音频路', findAudioMateId(all as never, 'p1', 'cam-a') === 'aud-a',
  findAudioMateId(all as never, 'p1', 'cam-a'))
check('不会拿到别人的音频路', findAudioMateId(all as never, 'p2', 'cam-b') === 'aud-b')
check('纯音频流自己所在的那一路不会被认为是自己的"音频路"',
  findAudioMateId(all as never, 'p1', 'aud-a') === '')

// 复现原 bug 的集合形态：只有视频瓦片（就是 `remoteStreams` 的样子）
const onlyVideo = all.filter((x) => x.video)
check('拿"只装视频瓦片"的列表来找，必须找不到（这就是原 bug 的形态）',
  findAudioMateId(onlyVideo as never, 'p1', 'cam-a') === '')

check('有音但有画的流不算纯音频路（画面自带音轨那种）',
  findAudioMateId([s('both', 'p1', 'camera', true, true)] as never, 'p1', 'cam-a') === '')
check('不活跃的不算', findAudioMateId([s('aud', 'p1', 'audio', false, true, false)] as never, 'p1', 'cam-a') === '')
check('ownerId 为空直接回空串（没入会/身份还没水合）', findAudioMateId(all as never, '', 'cam-a') === '')

if (fail) {
  console.log(`\navMate 取证：${fail} 条失败`)
  process.exit(1)
}
console.log('\navMate 取证：全过')
